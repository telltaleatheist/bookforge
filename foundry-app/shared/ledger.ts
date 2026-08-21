/**
 * The step ledger — a project's history as a tree that a person reads as a list.
 *
 * ── The failure this exists to prevent ──────────────────────────────────────
 *
 * Photoshop's History panel truncates. Step back three states, do anything at
 * all, and the three states after it are gone — which is correct for a filter
 * applied to pixels that can be applied again in a second, and catastrophic
 * here. Every payload in this app is hours of GPU or hours of a person's
 * judgement: a readings bank is a vision model over three hundred pages, a
 * translation is a model over every block of the book, a curation snapshot is
 * somebody's decisions about four hundred blocks. Truncating that history is
 * throwing away the only copies of things nobody can cheaply make again, in
 * response to a gesture — clicking an earlier row — that every user of every
 * history panel believes is free.
 *
 * So this one APPENDS. Every step records which step it was made FROM, and
 * acting while standing on an earlier step adds a step whose parent is the one
 * you were standing on. Translate to English, click back to the reading,
 * translate to Hungarian: the ledger reads import → reading → English →
 * Hungarian, Hungarian last because it happened last, its parent the reading.
 * Nothing was lost and nothing was asked.
 *
 * ── Structurally a tree, experientially a ledger ────────────────────────────
 *
 * That parent chain makes this a tree, and a tree UI would be the wrong answer
 * to a question nobody asked: people do not want to reason about a graph of
 * their book, they want to see what they have done and click back to any of it.
 * So `chronological` is the shape the UI gets — a flat list in creation order —
 * and the ONE concession to the tree is a quiet "from Read" on a row whose
 * parent is not the row immediately above it. A project worked straight through
 * has no annotations at all.
 *
 * ── Why every function here is pure ─────────────────────────────────────────
 *
 * Deleting a step destroys payload files; a re-run destroys the payload it
 * replaces; the migration rewrites the shape of every project on every user's
 * disk. That is the code in this app most worth covering with tests, and the
 * code that historically could not be reached by one, because it lived beside
 * `import { app } from 'electron'` (see the header of shared/steps.ts, which is
 * the same lesson learned the same way). So: no `fs`, no `path`, no `electron`,
 * no clock, no randomness. This module maps a ledger to a ledger, and answers
 * questions about one. Everything that touches a disk — reading the manifest,
 * unlinking the payloads a delete named, swapping a bank in on success — is the
 * main process's job, and stays there.
 *
 * `parseLedger` takes `unknown` rather than text for the same reason: reading a
 * file is the caller's business, including whatever it does about byte-order
 * marks and torn writes. This module's business starts at "here is a value that
 * claims to be a ledger", and its answer is either the ledger or a refusal that
 * names what is wrong with it.
 *
 * ── And the refusals are strict ─────────────────────────────────────────────
 *
 * This file is written whole by one program, so anything wrong with it is a
 * bug in that program — and a ledger half-read is worse than no ledger at all.
 * A step whose parent id is a typo, guessed at, is a book whose history says it
 * was translated from a reading it was not translated from. Every refusal names
 * the row and the field, so that the person who has to fix it can.
 */

import {
  STEP_ACTIONS,
  WHY_HANDMADE,
  WHY_IMPORTED,
  WHY_MODEL_PASS,
  type LedgerParams,
  type LedgerStep,
  type MetadataPatch,
  type ProjectLedger,
  type ProjectManifest,
  type ProjectReading,
  type ProjectStep,
  type ProjectTypeRecord,
  type RewriteMode,
  type StepAction,
  type StepRow,
} from './types';

/**
 * Refusals from this module, named so a caller can tell them from anything else.
 *
 * `StepLedgerError` rather than `LedgerError` because this app used to have two
 * ledgers — the block editor's persisted undo history was the other, and it is
 * deleted (docs/RENDERER.md §7). The name outlived the ambiguity it was written
 * to end, and it is kept: every refusal in this file already says it, and
 * renaming a thrown class to reclaim a word nothing else uses is churn.
 */
export class StepLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepLedgerError';
  }
}

/*
 * `STEP_ACTIONS` now lives beside `StepAction` in shared/types.ts, which
 * DERIVES the union from it — see the argument there. It was declared here and
 * the union was declared there, and the two disagreed for exactly as long as it
 * took to write a capture project to disk and try to read it back.
 *
 * Re-exported because this is where every reader of the ledger looks for it.
 */
export { STEP_ACTIONS };

/**
 * EVERY REWRITE THERE IS, and the two or three words a row calls it by.
 *
 * ONE TABLE FOR TWO JOBS, because they cannot be allowed to disagree. `readParams`
 * refuses a stored mode this app cannot name — a `rewrite` nobody here has heard
 * of is a step written by another program, and guessing at it would file somebody's
 * book under a prompt this build does not have — and `labelFor` prints the row.
 * Two lists would be one list plus a way for a new mode to be storable and
 * unprintable.
 *
 * THE WORDS ARE THE READER'S AND NOT THE ENGINE'S. `dejargon`, `destiffen` and
 * `learner` are flag values on a command line; "plain terms", "natural voice" and
 * "easy language" are what somebody scanning their own history is looking for. The
 * dialog says the same three phrases above the same three cards, which is what
 * makes the row recognisable as the thing that was pressed.
 */
export const REWRITE_LABELS: Readonly<Record<RewriteMode, string>> = {
  dejargon: 'plain terms',
  destiffen: 'natural voice',
  learner: 'easy language',
};

function isRewriteMode(said: string): said is RewriteMode {
  return Object.hasOwn(REWRITE_LABELS, said);
}

/**
 * WHAT IT WOULD COST TO GET THIS PAYLOAD BACK, per action — the retention rule
 * as one table.
 *
 * The rule, settled: an imported file is irreplaceable because it is the only
 * copy in the world and only the user knows where it came from; a model pass is
 * expensive because a machine can make it again at a price somebody would feel;
 * and A USER'S EDITS ARE IRREPLACEABLE REGARDLESS OF MACHINE COST, which is the
 * part a two-state "is this expensive" field got wrong. Freezing an overlay
 * costs nothing in CPU and cannot be reproduced by any amount of it.
 *
 * It is a table rather than four `if`s at four call sites because four passes
 * ask this question — the sweep, the delete confirm, the re-run decision, the
 * row — and a rule re-derived at each of them is a rule that drifts.
 */
export const RETENTION_OF: Readonly<Record<StepAction, LedgerStep['retention']>> = {
  import: 'irreplaceable',
  /*
   * AN ARRIVAL, ON `import`'s CLAUSE OF THE RULE RATHER THAN A NEW ONE. What a
   * capture step holds is an afternoon in an archive with a book that does not
   * leave the building, plus hand-placed quads over every page of it. No run
   * remakes either at any price.
   */
  capture: 'irreplaceable',
  read: 'expensive',
  curate: 'irreplaceable',
  translate: 'expensive',
  // A person read the title off the book in their hands and typed it. The write
  // took milliseconds and that is not the question this table asks — see the
  // sentence above about machine cost, and `StepAction` for why a metadata edit
  // is a step at all.
  metadata: 'irreplaceable',
  // A file of ops is somebody's decisions about four hundred blocks, written in
  // seconds and remade by nothing. It is the sharpest case this table's rule was
  // written for.
  edit: 'irreplaceable',
};

/**
 * Which params each action is allowed to carry. Anything else is refused by name.
 *
 * This is where the action-specificity that a discriminated union would have
 * given at the type level actually lives (see `LedgerParams`). A read carrying an
 * `amendments` count is not a read with a harmless extra field — it is a step
 * something wrote wrong, and the interesting question is which program wrote it.
 *
 * A READ CARRIES WHAT THE OCR DIALOG ASKED FOR AND WHAT THE RUN ANSWERED, in that
 * order of importance: `skipPages` and `language` are the question (`ReadRequest`
 * has exactly those two fields the user fills in), and `generation`, `pages` and
 * `completedAt` are what came back. Both piles are recorded; only the question is
 * compared. See `MINTED_BY_THE_RUN`, which is where that split is enforced.
 *
 * A TRANSLATE IS THE SAME TWO PILES IN THE SAME ORDER. `language` and `rewrite`
 * are the whole of what a dialog decides about which translation this is — the
 * language for a translation, and for a simplify the mode as well, because saying
 * a German book plainly and saying it in easy language are two books for two
 * readers and one of them must never swap its answers into the other's row.
 * `from` is the language a CHAINED run consumed, read off its parent rather than
 * typed; and `bank` is where a run made before records mode put its answers.
 *
 * `bank` IS KEPT FOR THE STEPS THAT HAVE ONE AND IS WRITTEN BY NOTHING. A
 * translation's answers are its own records file now, which is the step's PAYLOAD
 * — the same arrangement a reading has always had, where the bank is the payload
 * and no param names it. Every translation made before that is on somebody's disk
 * with `params.bank` in it, and a table that stopped admitting the field would
 * refuse those ledgers outright (`readParams` refuses a param the action does not
 * declare, by name). It is a field this app reads and never writes.
 */
export const PARAMS_OF: Readonly<Record<StepAction, readonly (keyof LedgerParams)[]>> = {
  /*
   * `arrangement` IS THE ONE THING AN ARRIVAL CAN BE ASKED ABOUT AFTERWARDS, and
   * it is here for mints rather than for imports in general — an import with a
   * parent is a mint (see `mintedStep`), and a mint is the one arrival this app
   * MAKES rather than receives. What it was made from is a fact about the recipe
   * at that instant, which nothing else can recover once the recipe moves on;
   * every other import's file came from outside and has no arrangement to record.
   * Absent is the ordinary state and always legal — every mint before Wave 21b,
   * and every import that is not a mint.
   */
  import: ['arrangement'],
  /*
   * NOTHING, for `import`'s reason: an arrival was not ASKED for, it happened.
   * How many photos there were and how many pages they became is a fact about
   * the recipe on disk, which is the payload — a params bag repeating it would
   * be two copies of one number with no rule about which wins.
   */
  capture: [],
  read: ['skipPages', 'language', 'generation', 'pages', 'completedAt'],
  curate: ['generation', 'amendments'],
  translate: ['language', 'bank', 'from', 'rewrite'],
  /*
   * A METADATA EDIT IS DESCRIBED BY WHICH FIELDS IT SET, and by nothing else. The
   * values are in the payload, where the thing an export replays belongs
   * (`MetadataPatch`, shared/types.ts) — a params bag that carried them too would
   * be two copies of one fact with no rule about which wins.
   *
   * NOTHING HERE IS IN `MINTED_BY_THE_RUN`, deliberately, and it costs nothing:
   * `reRunTarget` never returns an irreplaceable step, so two edits of the same
   * fields from one parent are two rows however this table reads. Which is the
   * answer the spec asks for — each Apply is a deliberate act and appends.
   */
  metadata: ['fields'],
  /*
   * AN EDIT IS DESCRIBED BY HOW MANY CHANGES IT WROTE, and by nothing else. The
   * changes themselves are the payload (`shared/ops.ts`), where the thing a
   * replay reads belongs; a params bag carrying them too would be two copies of
   * one fact with no rule about which wins — `metadata`'s argument, verbatim, one
   * action over.
   *
   * NOTHING HERE IS IN `MINTED_BY_THE_RUN` for `metadata`'s reason and it costs
   * nothing: `reRunTarget` never returns an irreplaceable step, so two Applies
   * from one parent are two rows however this table reads. Which is the answer
   * the design asks for — each Apply is a deliberate act, and it appends.
   */
  edit: ['ops'],
};

/**
 * ACTIONS THAT LEAVE YOU WHERE YOU WERE — a step retained BESIDE the position
 * rather than under it.
 *
 * ── The gesture this table exists to stop being punished ────────────────────
 *
 * Every other action moves the pointer onto what it just made, and that is
 * right for all of them: a reading and a translation are new states of the book,
 * and a person who queued one and then found the panes still showing the old one
 * would have watched an action produce nothing visible. A SAVE IS NOT ONE OF
 * THOSE. It does not make a new state; it retains the state you are already in
 * and hands it back to you unchanged.
 *
 * Moving the pointer onto a snapshot made the block editor read-only THE INSTANT
 * SOMEBODY PRESSED SAVE (`curationInEffect` → `curationLock`), which punished the
 * one gesture the whole restore-point idea depends on people making often — and
 * punished it for nothing, because at that instant the live overlay is byte for
 * byte the file that was just frozen, and the live one is the editable one. The
 * user pressed Save and the app took correcting away.
 *
 * Standing on a frozen save stays a deliberate act: you click the row. What
 * changes is only that the app never does it FOR you as the reward for saving.
 *
 * ── A TABLE, and the same shape as `RETENTION_OF` for the same reason ───────
 *
 * Two functions decide where the pointer lands — the append and the swap in
 * `recordLanding` — and a third would arrive the day another action is added.
 * A rule re-derived at a call site is a rule that drifts, and the way this one
 * drifts is that `overlay:commit` grows an `if` nothing else knows about.
 */
export const RETAINED_BESIDE_YOU: Readonly<Record<StepAction, boolean>> = {
  import: false,
  /*
   * THE POINTER STANDS ON IT, like an import. A capture IS the position a
   * project occupies until something is minted from it: there is no other row
   * to be standing on, and nothing beside it to be retained.
   */
  capture: false,
  read: false,
  curate: true,
  translate: false,
  /*
   * A METADATA EDIT IS THE SAME SHAPE OF GESTURE AS A SAVE, and the argument
   * above transfers word for word. It makes no new state of the book to go and
   * stand in — the document on screen already carries the new title, because the
   * dialog wrote it there — and moving the pointer onto the row would take the
   * block editor read-only as the reward for correcting an author's name, which
   * is the exact punishment this table was written to stop.
   */
  metadata: true,
  /*
   * AND AN EDIT IS THE ONE GESTURE OF THIS SHAPE THAT MUST NOT BE RETAINED BESIDE
   * YOU, which is worth arguing rather than asserting, because it looks like a
   * save and is not one.
   *
   * A curate step is retained beside you because the decisions it froze are
   * ALREADY IN EFFECT: the live overlay is byte for byte the snapshot at the
   * instant Apply is pressed, so the pointer has nothing to gain by moving and
   * something to lose by it. An edit step's ops are in effect NOWHERE ELSE. What
   * the pane draws is the reflowed book with the ops of every edit step on the
   * path from the position replayed over it (`editsInEffect`), and the stack that
   * held them in memory is cleared the moment the step lands. Leave the pointer
   * where it was and that path does not include the step that was just written:
   * the person presses Apply and watches every strike they made come back.
   *
   * So `false`, and the position follows onto the new row exactly as a reading's
   * or a translation's does — because, exactly like those, it IS a new state of
   * the book and there is somewhere new to stand.
   */
  edit: false,
};

/**
 * Params the RUN MINTED rather than params the run was ASKED FOR.
 *
 * ── The bug this table is the fix for ───────────────────────────────────────
 *
 * A re-run is "the same action, the same parameters, the same parent", and a
 * re-run means REPLACE. Read the same pages again and the new bank swaps in for
 * the old one; read a different book, or read from a different step, and it is a
 * new branch. That rule is the whole of `reRunTarget`.
 *
 * Compare a reading's params naively and the rule inverts itself. A re-read
 * MINTS A NEW GENERATION — that is what a generation is for, it is the app's
 * defence against amendments from a previous pass naming blocks in this one
 * (see `ProjectReading`) — so the second reading's `generation` never equals the
 * first's, no comparison ever matches, and every re-read appends a second
 * reading beside the one it was meant to replace. The user asked to read the
 * book again and got two banks, one of them stale, forever.
 *
 * So the comparison is over what was ASKED, and the generation is what came
 * back. The distinction is worth having a name for because it will come up
 * again: any params field a job STAMPS on its own answer belongs here.
 *
 * ── And `pages` is the field that proved it was a table ─────────────────────
 *
 * A page count is COUNTED OFF THE BANK AFTER THE RUN — `recordReading` counts the
 * lines in the file the engine wrote — so it is an answer in exactly the way a
 * generation is, and it sat in the question's pile for one release because it
 * ALMOST WORKS THERE. Two readings of one book usually produce the same count, so
 * a re-read usually matched the step it was meant to replace, and the count acted
 * as a proxy for "the same page range". The cases where the proxy fails are the
 * expensive ones and they fail silently:
 *
 *   A RE-READ WITH DIFFERENT `--skip-pages` produced a different count and so
 *   BRANCHED — leaving two `read` steps both naming the single
 *   `readings/<key>.jsonl` the engine writes, the older of them describing a bank
 *   that has since been archived out from under it. Two steps, one payload, and a
 *   row that renders somebody else's reading.
 *
 *   A RUN RESUMED after dying at page 200 landed with a bigger count and branched
 *   the same way — for a run that added pages to the very bank the first step
 *   names, which is the one case where "the same reading" is not even arguable.
 *
 * The fix is not to move `pages` on its own. It is to RECORD WHAT WAS ASKED FOR:
 * `ReadRequest` carries the page skips and the language and nothing else the user
 * chose, so those are what a reading is identified by, and the count went here
 * where it always belonged. A re-read of the same request replaces; a re-read
 * asking for a different page range is a different question and branches, which
 * is the rule stated rather than approximated.
 *
 * ── AND A TRANSLATION'S BANK IS THE SAME KIND OF FACT ───────────────────────
 *
 * `translate.bank` is the file the run wrote its answers into, recorded at the
 * landing from the path the plan handed the engine. Nobody asked for it — the
 * plan composed it out of the very decision this table serves, replace or branch —
 * so comparing it would be the generation trap in another folder: a re-translation
 * planned against the same step would carry the same bank and match, but a bank
 * that ever moved (a run planned as a branch landing as a replace) would make the
 * step it was meant to swap into unrecognisable, and the user would get a second
 * English translation beside the one they asked to redo.
 *
 * WHAT IS LEFT IN THE QUESTION IS `language` AND `rewrite`, AND DELIBERATELY SO. A
 * re-translation with different instructions or a different model is the same
 * person refining THIS translation of this book, not asking a new one — they get
 * the row they already have, with better contents in it. What makes a second
 * translation into one language a second row is standing somewhere else when you
 * ask for it, which `reRunTarget` settles by the parent before it ever reaches
 * these params. (If that ruling chafes, the fix is one line in `PARAMS_OF` — which
 * is the reason the table exists.)
 *
 * `rewrite` IS THE LINE THAT RULING PREDICTED, added when a simplify became a
 * translate step carrying a mode. It is a question in the same sense the language
 * is: three cards in a dialog, one of them chosen, and the choice is what the book
 * that comes out is FOR. Two modes sharing a row would mean asking for easy
 * language destroyed the plain-terms rewrite made from the same step — the exact
 * false replace this whole table is written to prevent, in the newest folder.
 *
 * `from` IS IN THE ANSWER PILE FOR A SHARPER VERSION OF THE SAME REASON. Nobody
 * typed it: a chained run reads the source language off its parent translate step,
 * and WHICH parent is already the first thing `reRunTarget` compares. Comparing it
 * again here would mean a re-translation of a chain stopped matching the row it
 * exists to refresh the day somebody corrected the parent's own language — a
 * second English row beside the one they asked to redo.
 */
const MINTED_BY_THE_RUN: Readonly<Record<StepAction, readonly (keyof LedgerParams)[]>> = {
  /*
   * `arrangement` IS AN ANSWER AND NOT A QUESTION — it is read off the recipe as
   * the mint begins, not typed by anybody — so it belongs on this side of the
   * split for the same reason `generation` and `pages` do. Nothing depends on it
   * today: `reRunTarget` never returns an irreplaceable step and every mint is
   * one, so two mints are two rows however this table reads. It is written down
   * anyway, because the day that changes the alternative is a second mint of the
   * same photographs REPLACING the first for having been made from a recipe that
   * had moved on — the mint's own docblock argues at length that an append is
   * the only honest answer there.
   */
  import: ['arrangement'],
  // No run mints anything for an arrival, and `PARAMS_OF.capture` is empty in
  // any case. Here so the table stays exhaustive.
  capture: [],
  read: ['generation', 'pages', 'completedAt'],
  curate: [],
  translate: ['bank', 'from'],
  // Everything a metadata edit records was typed by a person into a box. There
  // is no run to mint anything, and `reRunTarget` cannot reach an irreplaceable
  // step in any case — this entry exists so the table stays exhaustive rather
  // than because a comparison depends on it.
  metadata: [],
  // The same sentence about the same kind of gesture: nobody asked for an Apply's
  // ops, they ARE the Apply, and the count is read off the list as it is written.
  edit: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// Making one
// ─────────────────────────────────────────────────────────────────────────────

/** A project with no history recorded yet. */
export function emptyLedger(): ProjectLedger {
  return { steps: [] };
}

/**
 * The origin — an IMPORT, and one of the two steps a project can be rooted at.
 *
 * IT IS NO LONGER THE ONLY NULL-PARENTED STEP and this line used to say it was.
 * `captureStep` below is the other root: a project that arrived as photographs
 * is rooted at the capture rather than at a document, because there is no
 * document until something is minted. `parseLedger` still enforces exactly ONE
 * root per ledger, so the two are alternatives and never neighbours.
 *
 * NOR IS EVERY IMPORT NULL-PARENTED ANY MORE, which is the other half of what
 * this comment got wrong. `mintedStep` makes an import step WITH a parent, and
 * that is the whole marker distinguishing a minted PDF from an imported one —
 * see the argument there.
 *
 * It is not produced by a queue job and never was: importing is a file copy, and
 * the thing it retains is the untouched original, which is irreplaceable for the
 * one reason nothing else in a project is — some of these are scans of documents
 * that exist nowhere else, and nobody but the user knows where the file came
 * from.
 *
 * THE ID IS AN ARGUMENT rather than minted here. This module has no clock and no
 * randomness on purpose (see the header), and a uuid is both. Main mints it.
 */
export function originStep(
  id: string,
  payload: string,
  createdAt: number,
  label = 'Imported',
): LedgerStep {
  return { id, parent: null, action: 'import', payload, retention: RETENTION_OF.import, createdAt, label };
}

/**
 * The other origin — the one a project gets when it arrives as PHOTOGRAPHS.
 *
 * ── A SIBLING OF `originStep` AND NOT A PARAMETER ON IT ─────────────────────
 *
 * The two are the same shape and mean different things, and a function called
 * `originStep` that sometimes returns a capture step would be one name over two
 * meanings — the defect this feature has already found four times in its own
 * plan. Reading either of these tells you what it makes without checking what
 * was passed to it.
 *
 * ── APPENDED AT CREATION, WITH AN EMPTY RECIPE, WHICH IS FORCED ─────────────
 *
 * The light table belongs to the CAPTURE STEP rather than to a project that has
 * no PDF yet (docs/CAPTURE.md), so the step has to exist before the photographs
 * do: no step, no light table, and nowhere for the first photograph to land. A
 * capture step whose recipe holds zero photographs is therefore the ordinary
 * first state of one of these projects and not a hole in the record — the same
 * shape as the empty ledger an adoption leaves behind.
 *
 * IRREPLACEABLE, on the import clause of the rule rather than a new one. What
 * it stands for is an afternoon in an archive with a book that does not leave
 * the building, and hand-placed corners over every page of it. No run remakes
 * either at any price.
 *
 * THE ID IS AN ARGUMENT for `originStep`s reason: this module holds no clock
 * and no randomness on purpose, and main mints both.
 */
export function captureStep(
  id: string,
  payload: string,
  createdAt: number,
  label = labelFor('capture'),
): LedgerStep {
  return { id, parent: null, action: 'capture', payload, retention: RETENTION_OF.capture, createdAt, label };
}

/**
 * The PDF a mint made out of a capture — an import step WITH a parent.
 *
 * ── WHY THIS IS AN `import` AND NOT AN ACTION OF ITS OWN ────────────────────
 *
 * A minted PDF has to behave downstream exactly as an imported scan does, and
 * SEVEN places decide that by asking whether the step they are standing on is
 * an import: `hasBookAt` and `hostActPositionFrom` (shared/stages.ts),
 * `positionView`’s sheet (below), `documentOfStep` (electron/projects.ts), and
 * three renderer sites. Measured, not assumed. With `import` all seven are
 * right with no edits: there is no book until something reads the PDF, the host
 * acts on the reading rather than on the PDF row, and standing here opens the
 * live copy. A new action would have made every one of them silently wrong in
 * the same direction, and a missed one would not fail — it would just offer a
 * person a translation of a book that does not exist yet.
 *
 * ── AND THE PARENT IS THE MARKER, WHICH COSTS NOTHING TO ADD ────────────────
 *
 * `originStep` is the ONLY other place that builds an `import` step and it
 * hard-codes `parent: null`. So an import step with a parent is, by
 * construction, a mint — no new action, no new field, and nothing to keep in
 * sync. The parent is also FORCED rather than merely tidy: a capture ledger is
 * already rooted at its capture step, and `parseLedger` refuses a ledger with
 * two roots, so a null-parented mint would not load at all.
 *
 * ── IRREPLACEABLE, AND THAT IS NOT A HEDGE ─────────────────────────────────
 *
 * Retention is settled by the action (`parseLedger` refuses a step that
 * disagrees), so this is `irreplaceable` whether or not we like it — but it is
 * also true, for a reason that is easy to miss. The photographs and the recipe
 * do survive, so another mint is always possible; what cannot be recovered is
 * THIS document. A re-mint appends a NEW step, and the readings hanging off the
 * old one do not follow it. Discarding this destroys the thing every reading of
 * it was about. The discard wording is what had to change, not the field.
 *
 * ── THE ARRANGEMENT IS REQUIRED, WHICH IS THE POINT OF PUTTING IT HERE ──────
 *
 * `params.arrangement` is what the light table compares the live recipe against
 * to know whether the book on the shelf is behind it, and it can only ever be
 * recorded AT the mint — once the recipe moves on, nothing can recover what it
 * looked like. So it is an argument rather than something a caller remembers to
 * set afterwards: a mint step that exists without it is a mint nothing can ever
 * say anything true about, and the type is where that is cheapest to prevent.
 */
export function mintedStep(
  id: string,
  parent: string,
  payload: string,
  createdAt: number,
  arrangement: string,
  label = 'The pages you minted',
): LedgerStep {
  return {
    id,
    parent,
    action: 'import',
    payload,
    params: { arrangement },
    retention: RETENTION_OF.import,
    createdAt,
    label,
  };
}

/**
 * What a step is CALLED, in the app's voice — never a filename.
 *
 * The count is in the label rather than beside it because the row is one line
 * and "Read" alone is a row that does not say whether it read the book or four
 * pages of it. A step whose count nobody recorded says the plain word, which is
 * the honest answer and the one a migrated project gets.
 *
 * A CURATION SAVE SAYS WHAT THE BUTTON SAID. The button is Apply changes, and
 * the row it produces used to read "Saved corrections" — two names for one act,
 * which asks a person to work out that the row is the thing they just pressed.
 * "Corrections" was also a claim about the work: striking a running head or
 * relabelling a heading is a change to the book, not a correction of an error.
 *
 * LABELS ARE DISPLAY-ONLY, so old projects keep the words they were stamped with.
 * `LedgerStep.label` is stored, not derived, and rewriting every project's history
 * to match a rename would be this app editing the record of what happened to
 * somebody's book in order to tidy its own vocabulary. Nothing keys off the text —
 * the action does — so the two spellings sitting side by side in an old ledger
 * cost nothing but the truth that the rows were made a year apart.
 */
export function labelFor(action: StepAction, params?: LedgerParams): string {
  switch (action) {
    case 'import':
      return 'Imported';
    /*
     * AN ARRIVAL SAYS WHAT ARRIVED, and a capture arrived as pictures. It takes
     * no count the way a read does because `PARAMS_OF.capture` is empty on
     * purpose: how many photographs there are is a fact about the recipe, which
     * is this step's payload, and a label is not a record.
     *
     * IT NEEDS A CASE AT ALL because the `default` below is the translate
     * branch: without this line every capture row in every ledger would be
     * stamped "Translated", and no typecheck would ever say so.
     */
    case 'capture':
      return 'Photographs';
    case 'read':
      return params?.pages === undefined || params.pages <= 0 ? 'Read' : `Read (${params.pages} pages)`;
    case 'curate':
      return params?.amendments === undefined || params.amendments <= 0
        ? 'Applied changes'
        : `Applied changes (${params.amendments})`;
    /*
     * A METADATA ROW SAYS WHICH FIELDS IT SET, when saying so is short enough to
     * be a row rather than a paragraph. A project can hold half a dozen of these
     * and "Metadata" six times over is six rows nobody can tell apart; "Metadata
     * (title, author)" is the one thing a person remembers about the edit they
     * are looking for. Past a couple of fields the list stops being scannable and
     * the plain word is the honest answer — the payload still holds every one of
     * them, and this is a label rather than a record.
     */
    /*
     * AN EDIT ROW SAYS THE SAME WORDS A SAVE DOES, and that is deliberate rather
     * than an oversight. Both are the button labelled Apply changes; the person
     * pressing it is doing one thing — committing what is on screen — and giving
     * the two rows different names would ask them to work out which of this app's
     * two mechanisms their gesture happened to go through, which is the app's
     * bookkeeping and not theirs. What tells them apart in the tree is the count
     * and the position, and what tells the CODE apart is the action.
     */
    case 'edit':
      return params?.ops === undefined || params.ops <= 0
        ? 'Applied changes'
        : `Applied changes (${params.ops})`;
    case 'metadata': {
      const said = params?.fields ?? [];
      const printed = said.join(', ');
      return said.length === 0 || said.length > 3 || printed.length > 40
        ? 'Metadata'
        : `Metadata (${printed})`;
    }
    /*
     * A TRANSLATION NAMES BOTH ENDS WHERE ONE END IS NOT ENOUGH.
     *
     * "Translated (hu)" says everything there is to say about a book read in
     * German: there is one other language in the story, and it is the book's. A
     * CHAIN breaks that — *German → English → Hungarian* is two rows, and which
     * one the Hungarian was made from is the whole of what a person is looking for
     * when they click between them. So a run that consumed another translation
     * recorded what it consumed (`params.from`, written by nothing else) and the
     * row says "Translated (en → hu)".
     *
     * THE TAGS AND NOT THE NAMES, because the tags are what was asked for: the
     * dialog's own field says "language tags, not names", the engine refuses
     * anything that is not one, and a label that printed "English" for `en` would
     * be this app translating somebody's input in order to display it back.
     *
     * The single-hop wording is untouched, which is the point of the condition:
     * every row already on a disk keeps the words it was stamped with, and the
     * ones that go on being unambiguous keep them for good.
     */
    /*
     * A SIMPLIFY SAYS WHICH REWRITE AND NEVER SAYS AN ARROW, which is not a
     * shortcut — it is the shape of the act. A rewrite happens IN the book's own
     * language, so both ends of it are the same tag, and "Translated (de → de)"
     * would be a row describing a run nobody would ever order. What a person is
     * looking for on this row is which of the three they picked, so that is what
     * it leads with, and the tag stays in the parentheses where every other
     * translate row keeps it: a project can hold a German rewrite and an English
     * one, and they are told apart there.
     */
    default: {
      const into = params?.language ?? '';
      const rewrite = params?.rewrite;
      if (rewrite !== undefined) {
        const said = `Simplified — ${REWRITE_LABELS[rewrite]}`;
        return into.length === 0 ? said : `${said} (${into})`;
      }
      if (into.length === 0) return 'Translated';
      const outOf = params?.from ?? '';
      return outOf.length === 0 ? `Translated (${into})` : `Translated (${outOf} → ${into})`;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading one off disk
// ─────────────────────────────────────────────────────────────────────────────

const LEDGER_FIELDS = ['position', 'steps'] as const;
const STEP_FIELDS = ['id', 'parent', 'action', 'payload', 'params', 'retention', 'createdAt', 'label', 'stale'] as const;
const RETENTIONS = ['irreplaceable', 'expensive', 'regenerable'] as const;

/**
 * A stored value → a ledger, or a refusal that names the row and the field.
 *
 * ONE BAD ROW TAKES THE WHOLE FILE DOWN, exactly as one bad amendment takes an
 * overlay down. Skipping a row that will not parse is the failure mode worth
 * avoiding above all others here: a step quietly dropped is a payload nothing in
 * the app knows about any more, sitting in the project folder, invisible to the
 * sweep and to the delete confirm and to the user — hours of GPU that the app has
 * forgotten it owns. A refused ledger is recoverable; the caller says so, names
 * the file, and the project opens on its per-type rows.
 *
 * `unknown` rather than text: reading the file, and whatever has to be done about
 * byte-order marks or a torn write, is the caller's job.
 */
export function parseLedger(raw: unknown): ProjectLedger {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new StepLedgerError(`The step ledger is ${JSON.stringify(raw)}, which is not a ledger object`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(LEDGER_FIELDS as readonly string[]).includes(key)) {
      throw new StepLedgerError(
        `The step ledger carries a field called "${key}", and a ledger is `
        + `${LEDGER_FIELDS.join(' and ')} and nothing else`,
      );
    }
  }
  if (!Array.isArray(record['steps'])) {
    throw new StepLedgerError(
      `The step ledger's "steps" is ${JSON.stringify(record['steps'])}, and the steps are the whole of a ledger`,
    );
  }

  const steps = record['steps'].map((entry, index) => readStep(entry, index));

  // ── the id is what everything else in the file points at ──────────────────
  const byId = new Map<string, LedgerStep>();
  for (const step of steps) {
    if (byId.has(step.id)) {
      throw new StepLedgerError(
        `Two steps in this ledger are both called "${step.id}". An id is what a parent points at and `
        + 'what the pointer names, so two of them means neither can be resolved',
      );
    }
    byId.set(step.id, step);
  }

  // ── the parent chain: it exists, there is one root, and nothing loops ─────
  const roots: LedgerStep[] = [];
  for (const step of steps) {
    if (step.parent === null) {
      roots.push(step);
      continue;
    }
    if (!byId.has(step.parent)) {
      throw new StepLedgerError(
        `Step "${step.id}" (${step.label}) says it was made from "${step.parent}", and there is no such `
        + 'step in this ledger. What a step was made from is not something to guess at',
      );
    }
  }
  if (steps.length > 0 && roots.length === 0) {
    throw new StepLedgerError(
      'No step in this ledger is the origin — every one of them claims to have been made from another. '
      + 'A project begins with the file that was imported',
    );
  }
  if (roots.length > 1) {
    throw new StepLedgerError(
      `This ledger has ${roots.length} steps with no parent (${roots.map((step) => `"${step.id}"`).join(', ')}), `
      + 'and a project has one origin: the document it was made from. Everything else was made from something',
    );
  }
  for (const step of steps) {
    const seen = new Set<string>([step.id]);
    let walker = step.parent;
    while (walker !== null) {
      if (seen.has(walker)) {
        throw new StepLedgerError(
          `Step "${step.id}" (${step.label}) was made from itself, by way of "${walker}". A step's `
          + 'ancestry has to end at the import, and this one goes in a circle',
        );
      }
      seen.add(walker);
      walker = byId.get(walker)!.parent;
    }
  }

  // ── the array's order IS the chronology, so it has to hold ────────────────
  //
  // Non-DECREASING rather than strictly ascending, and the difference is a real
  // case rather than leniency: a migration stamps several rows from one recorded
  // time, and two jobs can land in one millisecond. What is refused is a row
  // claiming to have happened BEFORE the row above it, because `chronological`
  // draws this array in order and "the row immediately above" is what decides
  // whether a row needs its "from …" annotation.
  for (let at = 1; at < steps.length; at += 1) {
    const step = steps[at]!;
    const before = steps[at - 1]!;
    if (step.createdAt < before.createdAt) {
      throw new StepLedgerError(
        `Step "${step.id}" (${step.label}) is listed after "${before.id}" and claims to have happened `
        + 'before it. The steps are stored in the order they happened, and that order is the list a person reads',
      );
    }
  }

  const ledger: ProjectLedger = { steps };
  if ('position' in record && record['position'] !== undefined) {
    const position = record['position'];
    if (typeof position !== 'string') {
      throw new StepLedgerError(
        `This ledger's "position" is ${JSON.stringify(position)}, and the pointer names a step by its id. `
        + 'Leave it out entirely to stand on the newest step',
      );
    }
    if (!byId.has(position)) {
      throw new StepLedgerError(
        `This ledger's pointer stands on "${position}", and there is no such step in it. The pointer decides `
        + 'what the viewers show and what the next action is made from, so it is not something to guess at',
      );
    }
    ledger.position = position;
  }
  return ledger;
}

function readStep(entry: unknown, index: number): LedgerStep {
  const where = `Step ${index} of this ledger`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new StepLedgerError(`${where} is ${JSON.stringify(entry)}, not a step`);
  }
  const record = entry as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(STEP_FIELDS as readonly string[]).includes(key)) {
      throw new StepLedgerError(
        `${where} carries a field called "${key}", and a step has ${STEP_FIELDS.join(', ')} and nothing else`,
      );
    }
  }

  const id = record['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new StepLedgerError(`${where} says "id": ${JSON.stringify(id)}, and a step is named by a string`);
  }
  const parent = record['parent'];
  if (parent !== null && typeof parent !== 'string') {
    throw new StepLedgerError(
      `Step "${id}" says "parent": ${JSON.stringify(parent)}. It names the step this one was made from, `
      + 'or null for the import — and null has to be written out, because a missing parent and a parentless '
      + 'step are different claims',
    );
  }
  const action = record['action'];
  if (typeof action !== 'string' || !(STEP_ACTIONS as readonly string[]).includes(action)) {
    throw new StepLedgerError(
      `Step "${id}" says "action": ${JSON.stringify(action)}, which is not something this app does. `
      + `The actions are: ${STEP_ACTIONS.join(', ')}`,
    );
  }
  const payload = record['payload'];
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new StepLedgerError(
      `Step "${id}" says "payload": ${JSON.stringify(payload)}. Every step is the retained payload of one `
      + 'action, and a step naming no file is a step with nothing behind it',
    );
  }
  const retention = record['retention'];
  if (typeof retention !== 'string' || !(RETENTIONS as readonly string[]).includes(retention)) {
    throw new StepLedgerError(
      `Step "${id}" says "retention": ${JSON.stringify(retention)}. It says what it would cost to get this `
      + `payload back, and the answers are: ${RETENTIONS.join(', ')}`,
    );
  }
  const expected = RETENTION_OF[action as StepAction];
  if (retention !== expected) {
    // REFUSED RATHER THAN CORRECTED, because the sweep reads this field without
    // knowing what an action is. A file calling a reading `regenerable` is a file
    // giving something permission to delete hours of GPU on the grounds that it
    // is cheap to make again, and quietly rewriting it would hide whichever
    // program wrote it that way.
    throw new StepLedgerError(
      `Step "${id}" is a ${action} and calls itself "${retention}". A ${action} is "${expected}" — `
      + 'what it costs to get a payload back is settled by what made it, and a step that disagrees would '
      + 'send a sweep after something it must not touch',
    );
  }
  const createdAt = record['createdAt'];
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || !Number.isInteger(createdAt) || createdAt < 0) {
    throw new StepLedgerError(
      `Step "${id}" says "createdAt": ${JSON.stringify(createdAt)}, and it is a whole number of milliseconds `
      + 'since the epoch',
    );
  }
  const label = record['label'];
  if (typeof label !== 'string' || label.length === 0) {
    throw new StepLedgerError(
      `Step "${id}" says "label": ${JSON.stringify(label)}. The label is the only part of this bookkeeping a `
      + 'person is meant to read, and a row with nothing on it is a row nobody can click on purpose',
    );
  }

  const step: LedgerStep = {
    id,
    parent: parent as string | null,
    action: action as StepAction,
    payload,
    retention: retention as LedgerStep['retention'],
    createdAt,
    label,
  };
  if ('params' in record && record['params'] !== undefined) {
    step.params = readParams(record['params'], id, action as StepAction);
  }
  if ('stale' in record && record['stale'] !== undefined) {
    if (typeof record['stale'] !== 'boolean') {
      throw new StepLedgerError(
        `Step "${id}" says "stale": ${JSON.stringify(record['stale'])}, and it is true or false`,
      );
    }
    if (record['stale']) step.stale = true;
  }
  return step;
}

/**
 * The params that are WORDS rather than counts, so a stored one can be checked.
 *
 * A LIST RATHER THAN AN `if` OF LITERALS, which it used to be: with two string
 * fields the condition read fine, and the third one — `skipPages`, "3,17,19-24" —
 * would have been a fourth clause somebody could forget while adding a field, and
 * a forgotten clause here means a page range checked as if it were a page count
 * and refused for being a string. Everything not in here is a whole number.
 */
const WORDS = ['arrangement', 'bank', 'from', 'generation', 'language', 'skipPages'] as const;

function isWord(key: keyof LedgerParams): key is typeof WORDS[number] {
  return (WORDS as readonly string[]).includes(key);
}

/**
 * The params that are LISTS OF WORDS — which is one of them, and the reason it is
 * a table anyway is `WORDS`' own.
 *
 * `metadata.fields` is the field names one edit set, and it is stored as an array
 * because that is what it is. The considered alternative was a comma-joined string
 * on `skipPages`' precedent, and it is not the same case: `skipPages` is stored
 * verbatim because THE STRING IS WHAT WAS ASKED — "3,17" and "17,3" are two
 * spellings this app deliberately does not claim to know are one thing — where a
 * set of field names has no spelling of its own to preserve, and joining it would
 * be a list pretending to be a word, to be split again by every reader.
 */
const LISTS = ['fields'] as const;

function isList(key: keyof LedgerParams): key is typeof LISTS[number] {
  return (LISTS as readonly string[]).includes(key);
}

/** `a`, `a and b`, `a, b and c` — this app writes sentences, not comma runs. */
function spokenList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function readParams(value: unknown, id: string, action: StepAction): LedgerParams {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StepLedgerError(`Step "${id}" says "params": ${JSON.stringify(value)}, which is not a params object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = PARAMS_OF[action];
  const params: LedgerParams = {};
  for (const named of Object.keys(record)) {
    if (!(allowed as readonly string[]).includes(named)) {
      throw new StepLedgerError(
        `Step "${id}" is a ${action} and carries a param called "${named}". A ${action} is described by `
        + `${allowed.length === 0 ? 'nothing at all' : spokenList(allowed)}`,
      );
    }
    // Narrowed only after the membership check above, which is what earns the
    // cast: every key that reaches here is one this action declares.
    const key = named as keyof LedgerParams;
    const said = record[key];
    if (said === undefined) continue;
    if (key === 'rewrite') {
      // CHECKED AGAINST THE THREE THIS BUILD KNOWS rather than admitted as any
      // word, which is the one place a param earns more than "it is a string". A
      // mode is not free text a person typed — it is one of three cards — so a
      // fourth value in a file is a step some other program wrote, and taking it
      // at face value would leave a row this app can neither name nor re-run.
      if (typeof said !== 'string' || !isRewriteMode(said)) {
        throw new StepLedgerError(
          `Step "${id}" says "rewrite": ${JSON.stringify(said)}, and the rewrites are: `
          + `${Object.keys(REWRITE_LABELS).join(', ')}`,
        );
      }
      params.rewrite = said;
    } else if (isList(key)) {
      // EVERY ELEMENT CHECKED, and an empty list refused with the rest: a
      // metadata row that set no fields is a row about nothing, and the label it
      // composes would say the plain word while claiming an edit happened.
      if (!Array.isArray(said) || said.length === 0
        || said.some((named) => typeof named !== 'string' || named.length === 0)) {
        throw new StepLedgerError(
          `Step "${id}" says "${key}": ${JSON.stringify(said)}, and it is a list of field names with `
          + 'at least one name in it',
        );
      }
      params[key] = said as string[];
    } else if (isWord(key)) {
      if (typeof said !== 'string') {
        throw new StepLedgerError(`Step "${id}" says "${key}": ${JSON.stringify(said)}, and it is a string`);
      }
      params[key] = said;
    } else {
      if (typeof said !== 'number' || !Number.isInteger(said) || said < 0) {
        throw new StepLedgerError(
          `Step "${id}" says "${key}": ${JSON.stringify(said)}, and it is a whole number of 0 or more`,
        );
      }
      params[key] = said;
    }
  }
  return params;
}

// ─────────────────────────────────────────────────────────────────────────────
// Standing somewhere, and looking around
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The step the pointer stands on, or null for a project with no history yet.
 *
 * ABSENT MEANS THE NEWEST, which is where a project spends nearly all of its
 * life. Writing the pointer on every append would rewrite the manifest to record
 * a fact the array already implies, in a folder people sync.
 *
 * A pointer naming a step that is not here falls back to the newest rather than
 * throwing. `parseLedger` refuses that file outright, so this can only be reached
 * by a ledger built in memory — and the honest answer for a pointer that has come
 * loose is the place a project with no pointer stands.
 */
export function positionOf(ledger: ProjectLedger): LedgerStep | null {
  if (ledger.position !== undefined) {
    const standing = ledger.steps.find((step) => step.id === ledger.position);
    if (standing !== undefined) return standing;
  }
  let newest: LedgerStep | null = null;
  for (const step of ledger.steps) {
    if (newest === null || step.createdAt >= newest.createdAt) newest = step;
  }
  return newest;
}

/**
 * The import — the one step with no parent — or null for a ledger with none.
 *
 * ── Which actions are made from the position, and which from the document ───
 *
 * The position is the parent of whatever the user does next, and that is right
 * for every action whose INPUT is a step's payload: a translation reads a book
 * that was cast from a bank, a save freezes a curation of a reading. A READING IS
 * NOT ONE OF THOSE. It reads the pixels, which live in `archive/` and are the
 * project's origin — `planReading` resolves the source itself for exactly this
 * reason, because the document the user is looking at may be a real-text reprint
 * with no photograph in it at all.
 *
 * So a reading's parent is this, wherever the pointer happens to be, and getting
 * that wrong is expensive in the way this whole model exists to prevent. Standing
 * on the reading and pressing OCR again is the ordinary way somebody re-reads a
 * book; parented at the position it would append a reading MADE FROM a reading,
 * which is not a thing, and `reRunTarget` would never match it — so the project
 * would collect a chain of read steps, every one of them naming the single bank
 * file the engine writes, all but the newest describing a bank that has been
 * archived out from under it. Parented here, the second read replaces the first
 * and stales the saves and translations that were about the old blocks, which is
 * what actually happened.
 *
 * It is also what `migrateLedger` already does, and a reconstruction and a
 * recording that disagreed about the shape of one project's history would be two
 * accounts of one book.
 */
export function originOf(ledger: ProjectLedger): LedgerStep | null {
  return ledger.steps.find((step) => step.parent === null) ?? null;
}

/** The step of that id, or a refusal naming it. */
export function stepOf(ledger: ProjectLedger, id: string): LedgerStep {
  const step = ledger.steps.find((candidate) => candidate.id === id);
  if (step === undefined) {
    throw new StepLedgerError(`This ledger has no step called "${id}"`);
  }
  return step;
}

/**
 * The chain that produced a step: the origin first, the step itself last.
 *
 * WALKED BY PARENT POINTER AND NOT BY ARRAY POSITION, because the array is in
 * creation order and creation order is not the chain. The whole point of this
 * design is that the step made most recently may have been made from something
 * six rows up.
 */
export function ancestry(ledger: ProjectLedger, id: string): LedgerStep[] {
  const chain: LedgerStep[] = [];
  const seen = new Set<string>();
  let walker: string | null = id;
  while (walker !== null) {
    if (seen.has(walker)) {
      throw new StepLedgerError(`Step "${id}" has an ancestry that goes in a circle, by way of "${walker}"`);
    }
    seen.add(walker);
    const step = stepOf(ledger, walker);
    chain.unshift(step);
    walker = step.parent;
  }
  return chain;
}

/** The steps made directly from this one, in creation order. */
export function childrenOf(ledger: ProjectLedger, id: string): LedgerStep[] {
  return ledger.steps.filter((step) => step.parent === id);
}

/**
 * A step and everything made from it, in creation order.
 *
 * WHAT A DELETE ACTUALLY COSTS. Deleting a step takes its descendants with it —
 * a reading's translations were made from that reading and have nowhere to hang
 * — and the confirm names every one of them before the user agrees. Creation
 * order because that is the order the confirm lists them in and the order the
 * user saw them appear.
 */
export function subtree(ledger: ProjectLedger, id: string): LedgerStep[] {
  // WALKED DOWNWARD RATHER THAN SCANNED ONCE, and the difference is a real
  // correctness hole rather than a style. A single forward pass over the array
  // only works if every parent is listed before its child, and that is an
  // invariant `appendStep` happens to produce but the file format does not
  // promise: rows stamped in one millisecond are allowed in any order, so a
  // grandchild listed above its parent would be missed — and a delete that
  // missed a descendant would leave a step pointing at a parent it had just
  // destroyed, which is a ledger that refuses to load.
  const children = new Map<string, LedgerStep[]>();
  for (const step of ledger.steps) {
    if (step.parent === null) continue;
    children.set(step.parent, [...(children.get(step.parent) ?? []), step]);
  }
  const taken = new Set<string>();
  const pending = [stepOf(ledger, id)];
  while (pending.length > 0) {
    const step = pending.pop()!;
    if (taken.has(step.id)) continue;
    taken.add(step.id);
    pending.push(...(children.get(step.id) ?? []));
  }
  return ledger.steps.filter((step) => taken.has(step.id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Acting: append, or replace
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A step, added — and the pointer moved onto it, unless the step is one that is
 * retained beside you.
 *
 * IMMUTABLE, returning a new ledger, because the caller is `withManifest` in the
 * main process and a half-applied mutation on a throw is a manifest that
 * disagrees with the disk. Nothing here edits what it was given.
 *
 * THE POINTER FOLLOWS FOR EVERY ACTION BUT ONE. A person who stepped back to the
 * reading and translated is now standing on the translation — that is what they
 * just made, and it is what the viewers should be showing. Leaving the pointer
 * where it was would mean the act of translating produced nothing visible. A
 * curation save is the exception and `RETAINED_BESIDE_YOU` is where that is said
 * once, in general, rather than as a special case at the one call site that
 * happens to make one today.
 */
export function appendStep(ledger: ProjectLedger, step: LedgerStep): ProjectLedger {
  if (ledger.steps.some((existing) => existing.id === step.id)) {
    throw new StepLedgerError(`This ledger already has a step called "${step.id}"`);
  }
  if (step.parent === null) {
    if (ledger.steps.length > 0) {
      throw new StepLedgerError(
        `Step "${step.id}" (${step.label}) has no parent, and this project already has an origin. `
        + 'Every step after the import was made from something',
      );
    }
  } else if (!ledger.steps.some((existing) => existing.id === step.parent)) {
    throw new StepLedgerError(
      `Step "${step.id}" (${step.label}) says it was made from "${step.parent}", and there is no such step `
      + 'in this ledger',
    );
  }

  // CLAMPED RATHER THAN REFUSED, and this is the one place the two directions
  // differ. `parseLedger` refuses a file whose rows run backwards, because a
  // stored file like that was written by something other than this function. But
  // a clock that steps backwards between two appends is ordinary — an NTP
  // correction, a laptop waking up — and refusing to record a run that has
  // already finished would throw away the payload it produced to protect the
  // order of a list. The list wins; the payload is what matters.
  const last = ledger.steps[ledger.steps.length - 1];
  const createdAt = last === undefined ? step.createdAt : Math.max(step.createdAt, last.createdAt);

  return {
    ...ledger,
    position: pointerAfter(ledger, step),
    steps: [...ledger.steps, createdAt === step.createdAt ? step : { ...step, createdAt }],
  };
}

/**
 * Where the pointer stands once this step exists — the table, applied.
 *
 * IT IS WRITTEN OUT EVEN WHEN IT DOES NOT MOVE, and that is the whole subtlety of
 * a retained step. An absent pointer does not mean "no pointer": it means THE
 * NEWEST STEP (`positionOf`), and appending is exactly the operation that makes
 * this step the newest. So a project with no pointer that froze a save would have
 * had the pointer follow the save anyway, silently, through the very field that
 * exists to spare the manifest a line — the bug this whole rule is about,
 * arriving by the back door. Recording the position the user is actually standing
 * on is what makes "it did not move" true rather than merely intended.
 *
 * The fallback is the new step itself, for a ledger that had nothing in it to
 * stand on. No action that is retained beside you can be the first step in a
 * project — a save is made FROM a reading — so this is the honest answer to a
 * question that cannot be asked rather than a case being handled.
 */
function pointerAfter(ledger: ProjectLedger, step: LedgerStep): string {
  if (!RETAINED_BESIDE_YOU[step.action]) return step.id;
  return positionOf(ledger)?.id ?? step.id;
}

/**
 * The two fields the OCR dialog lets somebody fill in, exactly as they typed them.
 *
 * It is a named shape rather than an inline object because THREE places now hold
 * one: the dialog that asks, the plan that decides where the bank goes, and the
 * landing that records what was asked. All three have to mean the same thing by
 * it, and a shape spelled three times is a shape that grows a field in two of
 * them.
 */
export interface ReadAsk {
  /** `--skip-pages`, verbatim: "3,17,19-24". */
  skipPages?: string;
  /** `--language`: the BCP-47 tag, declared and never detected. */
  language?: string;
}

/**
 * What a reading ASKED, as params — trimmed, and dropped when there is nothing
 * left.
 *
 * ── Why this is a function and not two spreads at each call site ────────────
 *
 * A blank `--skip-pages` box and an absent field are the same statement, and two
 * spellings of it are two questions as far as `reRunTarget` is concerned: the
 * same book read twice would branch because one run recorded the empty string
 * somebody's cursor left behind. That rule used to live inline in `recordReading`
 * and nowhere else, which was fine while the landing was the only thing that
 * asked the question.
 *
 * IT IS NOT ANY MORE, and the drift would be expensive in a new way. The bank's
 * PATH is now decided before the job is enqueued, by asking `reRunTarget` the
 * same question the landing will ask hours later — so a plan that trimmed
 * differently from the landing would mint a branch path for a run the landing
 * then files as a replace, and the step and the file it names would disagree
 * about which bank belongs to which reading. One normalisation, asked twice.
 */
export function askedOf(asked: ReadAsk): LedgerParams {
  const params: LedgerParams = {};
  const skipPages = asked.skipPages?.trim() ?? '';
  if (skipPages.length > 0) params.skipPages = skipPages;
  const language = asked.language?.trim() ?? '';
  if (language.length > 0) params.language = language;
  return params;
}

/**
 * What a TRANSLATION asked, as params — the one field, trimmed, dropped when
 * blank.
 *
 * `askedOf`'s argument, in the other folder and for the same two askers. The
 * language decides whether the next translation of this book from this step
 * replaces the row or branches beside it, and it is asked twice: once by the plan
 * that names the EPUB and the bank, and again hours later by the landing that
 * records the step. A plan that trimmed differently from the landing would mint a
 * branch's filenames for a run the landing files as a replace, and the step and
 * the files it names would describe different translations.
 *
 * BLANK IS ABSENT, and `labelFor` already prints the plain word "Translated" for a
 * step that says nothing about itself — which is what a migrated translation gets,
 * because its language survives only inside a filename and this app does not read
 * facts out of those.
 */
export function translatedInto(
  language: string | undefined,
  /**
   * THE REWRITE, FOR A SIMPLIFY, AND ABSENT FOR EVERY ORDINARY TRANSLATION.
   *
   * It rides here rather than being spread in at the two call sites for the whole
   * of the paragraph above: the plan and the landing compose one params bag by one
   * function, so they cannot come to different answers about which row this run is.
   * A simplify's identity is the language AND the mode, and a mode dropped at
   * either end would aim easy language at the plain-terms row.
   */
  rewrite?: RewriteMode,
): LedgerParams {
  const said = language?.trim() ?? '';
  const params: LedgerParams = said.length === 0 ? {} : { language: said };
  if (rewrite !== undefined) params.rewrite = rewrite;
  return params;
}

/** What the user is about to do, before it has an id or a payload. */
export interface StepRequest {
  action: StepAction;
  /** The position at the moment they pressed the button. Null only for the import. */
  parent: string | null;
  params?: LedgerParams;
}

/**
 * The step this action would REPLACE, or null when it would branch.
 *
 * ── The one decision the whole model turns on ───────────────────────────────
 *
 * Same action, same parameters, same parent is a RE-RUN, and a re-run replaces:
 * the new payload swaps in when the run completes and the old one is destroyed,
 * with no timestamped hoards left behind. Anything else — another language,
 * another page range, the same action from a different step — is a BRANCH, which
 * appends and is always safe. Getting this backwards in either direction is
 * expensive in a different way: a false replace destroys a payload somebody
 * wanted, and a false branch leaves the project holding two banks where the user
 * asked for one.
 *
 * ── Why irreplaceable steps are never a target ──────────────────────────────
 *
 * Replacing means destroying, and the retention rule says user labour is never
 * destroyed by a re-run — it goes stale, visibly, and stays clickable. So an
 * irreplaceable step cannot be replaced by construction rather than by a list of
 * exceptions: the origin is never re-run (a project has one import), and two
 * curation saves from one parent are two saves, which is exactly what the spec
 * says they are. That falls out of the retention rule instead of restating it.
 *
 * ── And why a stale step IS a target ────────────────────────────────────────
 *
 * Deliberately. A translation that went stale because its reading was replaced
 * is the exact thing a user re-runs, and re-running it from the same step with
 * the same language is them saying "make this one current again". Refusing would
 * leave them with no way to refresh a branch except to delete it.
 */
export function reRunTarget(ledger: ProjectLedger, request: StepRequest): LedgerStep | null {
  const asked = identityOf(request.action, request.params);
  return ledger.steps.find((step) => (
    step.action === request.action
    && step.parent === request.parent
    && step.retention !== 'irreplaceable'
    && identityOf(step.action, step.params) === asked
  )) ?? null;
}

/**
 * The QUESTION a step asked, as one string — the thing two runs are compared by.
 *
 * ORDER-INDEPENDENT because it walks the action's own field list rather than the
 * object's keys: `{pages: 17, generation: 'a'}` and `{generation: 'a', pages: 17}`
 * are the same question however JSON happened to spell them, and an equality
 * built on key order would call them different runs.
 *
 * UNDEFINED IS ABSENT. A params bag written `{language: undefined}` and one
 * written `{}` are the same statement — a field somebody explicitly set to
 * nothing said nothing — and treating them as different would make a re-run
 * depend on how the calling dialog happened to build its object.
 */
function identityOf(action: StepAction, params?: LedgerParams): string {
  const minted = MINTED_BY_THE_RUN[action];
  const said: string[] = [action];
  for (const key of PARAMS_OF[action]) {
    if ((minted as readonly string[]).includes(key)) continue;
    const value = params?.[key];
    if (value === undefined) continue;
    said.push(`${key}=${JSON.stringify(value)}`);
  }
  return said.join('\u0000');
}

// ─────────────────────────────────────────────────────────────────────────────
// Which files a translation writes
//
// A translation makes two: the EPUB a person reads and the bank of answers it
// was assembled from. Both used to be composed from the project and the language
// alone — one name per book per language, forever — and both therefore COLLIDED
// the moment the ledger let a book hold two translations into one language. The
// user's own scenario is exactly that: translate, strike some blocks, commit,
// translate the curation. Two steps, two banks, and one filename.
//
// So the names are decided the way a reading's bank is (docs/BANK-LIFECYCLE.md
// §4.1): the FIRST translation into a language keeps the plain name every project
// on every disk already has, and a BRANCH mints `<name>.<id8>.<ext>` from the
// front of its own step's uuid. Nobody reads these strings — filenames are out of
// the UI and `labelFor` is what a row says — they exist so that two answers about
// one book cannot be written into one file.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The front of a uuid, hyphens removed — eight hex characters.
 *
 * The hyphens are stripped rather than sliced around because a uuid's first group
 * is already eight characters and this would still be right if anything ever
 * handed it an id spelled without them. Deterministic, collision-free for the
 * handful of files one project holds, and already minted: an ordinal would read
 * better in Explorer and would be a second counter to keep consistent with the
 * ledger.
 */
export function id8(uuid: string): string {
  return uuid.replace(/-/g, '').slice(0, 8);
}

/**
 * A language as it may appear in a filename — the ONE spelling of that reduction.
 *
 * It reaches two names (the EPUB and the bank) and is recomposed a third time when
 * a step that predates recorded banks has to be asked which bank it means, so a
 * second copy of this regex is a third answer waiting to disagree with the other
 * two. `pt-BR` survives unchanged; the engine has already refused anything that is
 * not a language tag, and the fallback is a word rather than an empty string
 * because a file called `Book ().epub` is a file nobody can tell from a mistake.
 */
export function languageTagFor(language: string): string {
  return language.trim().replace(/[^A-Za-z0-9-]+/g, '') || 'translated';
}

/**
 * A translation's name: the book's, with the language in parentheses.
 *
 * `Working Towards The Fuhrer. Kershaw, Ian. (1993) (en).epub`. Parentheses and
 * not a `.en.` infix, because an infix reads as a technical suffix on a filename
 * and the whole point of naming these from the book is that a person opening the
 * folder recognises what they are looking at.
 *
 * It still ends in `.epub`, and that is load-bearing: main's `openDocument` admits
 * a finished file by its extension, so an output named anything else could never
 * be opened, read or shown in a tab. The branch suffix therefore goes BEFORE the
 * extension and never after it.
 */
export function translationFileFor(stem: string, language: string, branch?: string): string {
  const tag = languageTagFor(language);
  return `${stem} (${tag})${branch === undefined ? '' : `.${branch}`}.epub`;
}

/**
 * A translation bank's name: the project's key, the language, and what it is.
 *
 * IN `readings/` BESIDE THE READINGS BANK, because both are the same thing — hours
 * of GPU held as answers about this book — and a folder that separated them by
 * which model produced them would be filing by implementation. `.bank.` is what
 * tells the two apart to a person looking at the directory; nothing in the app
 * ever tells them apart by name (see `banksAmong`, which asks the step).
 */
export function translationBankFileFor(key: string, language: string, branch?: string): string {
  const tag = languageTagFor(language);
  return `${key}.${tag}${branch === undefined ? '' : `.${branch}`}.bank.jsonl`;
}

/**
 * A translation's RECORDS: the project's key, the language, and what it is.
 *
 * ── The file that replaced both the bank and the book ───────────────────────
 *
 * A translation used to leave two things: `generated/<book> (hu).epub`, which is
 * what a person read, and `readings/<key>.hu.bank.jsonl` beside it, which is what
 * made re-translating nearly free. It leaves ONE now — a row per flowing block,
 * keyed by the block's position in the reading bank — and that one file is both:
 * the book is cast from it on demand, and an unchanged block's question is
 * already answered in it, so it is never asked twice. `translate --records`
 * refuses `--bank` beside it by name for exactly that reason.
 *
 * IN `readings/` BESIDE THE OTHER TWO, because all three are the same thing:
 * hours of a model held as answers about this book. `.records.` is what tells them
 * apart to a person looking at the directory; nothing in the app ever tells them
 * apart by name — it asks the step (`translationRecordsOf`).
 *
 * THE SAME BRANCH SUFFIX AS EVERYTHING ELSE IN HERE, and it is the same decision:
 * the first translation into a language keeps the plain name, and a second one
 * made from a different step mints `<id8>` from its own uuid, so the older row
 * goes on naming the answers it is actually about (`translationTarget`).
 */
export function translationRecordsFileFor(
  key: string,
  language: string,
  branch?: string,
  /**
   * The rewrite, for a simplify — a segment BEFORE the branch id and absent
   * entirely for a translation.
   *
   * BEFORE THE BRANCH, because the branch id is the last thing that distinguishes
   * two otherwise identical asks and reads as the tie-breaker it is:
   * `<key>.de.destiffen.a1b2c3d4.records.jsonl` is a second natural-voice German
   * rewrite, where `<key>.de.a1b2c3d4.destiffen...` would put the tie-breaker
   * before the thing it breaks a tie about.
   *
   * ABSENT ENTIRELY IS THE LOAD-BEARING HALF. Every records file on every disk was
   * written by a translation, and a mode segment that appeared as an empty string
   * or a placeholder would rename all of them — leaving the steps that name them
   * pointing at files that are no longer there. A translation composes exactly the
   * name it has always composed.
   */
  mode?: RewriteMode,
): string {
  const tag = languageTagFor(language);
  const rewrite = mode === undefined ? '' : `.${mode}`;
  return `${key}.${tag}${rewrite}${branch === undefined ? '' : `.${branch}`}.records.jsonl`;
}

/**
 * THE RECORDS A TRANSLATE STEP MEANS — its own payload — or null for one made
 * before translations were records.
 *
 * ── Why the payload IS the answer, and what that replaced ──────────────────
 *
 * A translate step used to retain the EPUB the translator wrote, with the bank
 * beside it recorded as a param. It retains the RECORDS FILE now, and the
 * symmetry with a reading is exact rather than convenient: both actions run a
 * model over a whole book, both produce a `.jsonl` of per-position answers in
 * `readings/`, and for both of them the document a person reads is CAST from that
 * file for nothing, at any time. A read step's payload has always been its bank
 * (docs/BANK-LIFECYCLE.md §4.1); this is the same sentence about the other model
 * pass. `orphanedPayloads` therefore protects and destroys a translation's answers
 * by the rule it already had, with nothing taught to it.
 *
 * ── How an old row is told apart, and why it is not by its name ────────────
 *
 * By its LAYER, which this app composed itself: a translate step's payload is
 * either the records file it wrote (`readings/`) or the EPUB the old EPUB→EPUB
 * translator wrote (`generated/`), and nothing else has ever been either. That is
 * not the basename matching the house rule forbids — no segment is compared, no
 * extension is parsed for meaning, and the two layers mean two different things
 * everywhere else in this app for the same reason they do here.
 *
 * NULL IS AN ORDINARY ANSWER, not a defect: it is every translation made before
 * this unit, and what those rows have instead is a book on disk and a bank beside
 * it (`translationBankOf`).
 */
export function translationRecordsOf(step: LedgerStep): string | null {
  if (step.action !== 'translate') return null;
  return step.payload.startsWith('readings/') ? step.payload : null;
}

/**
 * THE BANK A TRANSLATE STEP MEANS — what it recorded, or the path its language
 * composes for a step that landed before banks were recorded.
 *
 * ── Why the fallback is not a legacy branch to be deleted later ─────────────
 *
 * Every translation made before `params.bank` existed wrote
 * `readings/<key>.<tag>.bank.jsonl`, because that is the only name
 * `planTranslation` could compose — one per book per language, and there was only
 * ever one. Those steps are on real disks and their banks are real answers, so
 * asking them where their bank is has to produce that path rather than nothing. A
 * step that recorded one is answered from the record, which is the whole point of
 * recording it.
 *
 * NULL FOR A STEP THAT CANNOT SAY. A migrated translation has no `language` param
 * at all — the old catalogue kept the language only inside a filename, and reading
 * a fact back out of one is what this codebase's oldest house rule forbids — so
 * there is no tag to compose with and no honest answer. The sweep treats that as
 * "this step names no bank", which leaves a file alone rather than guessing which
 * file to destroy.
 */
export function translationBankOf(step: LedgerStep, key: string): string | null {
  if (step.action !== 'translate') return null;
  /*
   * A RECORDS-MODE TRANSLATION HAS NO BANK AT ALL, and saying so here is what
   * keeps the composed fallback below from inventing one. Its records file IS its
   * bank — the engine refuses `--bank` beside `--records` for that reason — so it
   * records no `params.bank`, and without this line the fallback would compose
   * `readings/<key>.<tag>.bank.jsonl` for it: a path belonging to some other
   * project's legacy translation or to nothing, offered to the sweep as a file
   * this step's delete may destroy.
   */
  if (translationRecordsOf(step) !== null) return null;
  const recorded = step.params?.bank;
  if (recorded !== undefined && recorded.length > 0) return recorded;
  const language = step.params?.language;
  if (language === undefined || language.trim().length === 0) return null;
  return `readings/${translationBankFileFor(key, language)}`;
}

/** What a translation is about to be, before it has run: the whole of the ask. */
export interface TranslationAsk {
  /** The position at the moment the button was pressed. See `LandedRun.parent`. */
  parent: string | null;
  /** `--to`, as the dialog named it. The whole of what makes this translation this one. */
  language: string;
  /**
   * The project key, which the records file is named after.
   *
   * THE BOOK'S STEM USED TO BE IN HERE TOO, for the EPUB this run no longer
   * writes. What a translation produces is answers, and answers are named for the
   * project rather than for the book — the same rule the readings bank has always
   * obeyed, one file over.
   */
  key: string;
  /**
   * The rewrite, when this ask is a SIMPLIFY — absent for a translation.
   *
   * It is in the ask rather than only on the command line because it decides both
   * halves of what this function answers: which step this run belongs to (the
   * mode is part of the question `reRunTarget` compares) and what its file is
   * called (a plain-terms rewrite and an easy-language one are two sets of answers
   * about one book in one language, and one filename holding both is the collision
   * this whole section exists to have ended).
   */
  rewrite?: RewriteMode;
}

/** Where this translation's answers go, and which step they belong to. */
export interface TranslationTarget {
  /** `LandedRun.id` for this run: an existing step on a replace, the minted id on a branch. */
  stepId: string;
  /**
   * The records file, project-relative. `LedgerStep.payload` when this lands.
   *
   * ONE PATH WHERE THERE USED TO BE TWO. This carried an `output` (the EPUB) and a
   * `bank` beside it, because a translation wrote a book and banked its answers in
   * a second file. It writes records and nothing else now, that file is the
   * step's payload, and the book is cast from it afterwards under a name composed
   * from the step itself (`translationCastFile`) — so there is one decision here
   * instead of two that had to agree.
   */
  records: string;
  /** The step this would swap into, or null when it appends beside one. */
  replaces: LedgerStep | null;
}

/**
 * WHICH TRANSLATION THIS IS, decided before the job is enqueued — the same
 * question the landing will ask, asked once here so the files and the row agree.
 *
 * ── Why the names cannot wait for the landing ───────────────────────────────
 *
 * The engine is handed two paths and writes into them for hours. By the time
 * anything lands there is nothing left to decide, so "is this the translation that
 * already exists, or a new one beside it?" is answered at the plan — by
 * `reRunTarget`, with the same three arguments the landing uses, or the file and
 * the step would describe different translations.
 *
 * ── The three answers ───────────────────────────────────────────────────────
 *
 * A REPLACE AIMS AT THE STEP'S OWN RECORDS. Same row, same path, new contents —
 * which is what `recordLanding` already says about the row, now true of the file.
 * Re-translating into a records file that is already full is what makes a
 * re-translation nearly free: every block whose masked source has not changed is
 * already answered in there and is never asked again.
 *
 * A REPLACE OF A ROW THAT PREDATES RECORDS AIMS AT THE PLAIN NAME instead, and it
 * is the one case where a re-run genuinely moves a payload. That step retains an
 * EPUB the old translator wrote (`translationRecordsOf` answers null for it); this
 * run writes records, so the row's payload changes layer, and `Landing.displaced`
 * is what destroys the book it used to name once no surviving row does. The answers
 * that book was assembled from are re-asked in full — the masked source moved a
 * stage earlier when records arrived, so every key in the old bank misses by design
 * (docs/WORKBENCH.md §10, ruling 1) — and that price was accepted when the format
 * was bumped rather than discovered here.
 *
 * A FIRST TRANSLATION INTO A LANGUAGE KEEPS THE PLAIN NAME, which is the same
 * courtesy the banks and the EPUBs were given: nothing about a project's first
 * translation into German should be spelled with a uuid in it.
 *
 * A BRANCH MINTS `<name>.<id8>.jsonl`. It deliberately does NOT share the first
 * translation's file: sharing would be harmless for cache hits and would let a
 * delete of either step destroy the answers the other one is made of, which is the
 * failure `orphanedPayloads` exists to prevent.
 *
 * ── "Plain" is asked of the ledger, by the whole path ───────────────────────
 *
 * Whether the plain name is free is decided by whether any step already names it,
 * by the whole project-relative path (`namesPayload`'s rule). The legacy names are
 * not consulted and do not need to be: a project holding a pre-records German
 * translation has its EPUB in `generated/` and its bank under `.bank.jsonl`, and
 * neither of those is a records file, so the plain records name is genuinely free.
 */
export function translationTarget(
  ledger: ProjectLedger,
  ask: TranslationAsk,
  /** Spent only on a branch. See `LandedRun.id` for the same arrangement. */
  minted: string,
): TranslationTarget {
  const plain = `readings/${translationRecordsFileFor(ask.key, ask.language, undefined, ask.rewrite)}`;
  const target = reRunTarget(ledger, {
    action: 'translate',
    parent: ask.parent,
    params: translatedInto(ask.language, ask.rewrite),
  });
  if (target !== null) {
    return {
      stepId: target.id,
      // The fallback is `plain` by construction rather than by coincidence: a
      // re-run target matched on the SAME language and the SAME rewrite from the
      // SAME parent, so the path those compose is the path this ask composes. It
      // is taken only by a row that predates records, which had no records file
      // to name — and no such row can be a simplify, because a rewrite has never
      // existed outside records mode.
      records: translationRecordsOf(target) ?? plain,
      replaces: target,
    };
  }
  const taken = ledger.steps.some((step) => step.payload === plain);
  if (!taken) return { stepId: minted, records: plain, replaces: null };
  return {
    stepId: minted,
    records: `readings/${translationRecordsFileFor(ask.key, ask.language, id8(minted), ask.rewrite)}`,
    replaces: null,
  };
}

/**
 * THE FACSIMILE ONE READ STEP MADE OF ITS OWN PAGES —
 * `<stem> (facsimile).<id8>.pdf`, project-relative.
 *
 * ── What it is, and why the reading makes one without being asked ───────────
 *
 * A reading's product is a BANK, and a bank is not a thing anybody can look at.
 * The flowing book is one of the two documents that come out of it; the other is
 * the page-for-page record — the scan's own pages, reprinted from the answers as
 * real text — and the ruling is that it exists the moment the reading does
 * (docs/RENDERER.md §0 A3, §6). It is TERMINAL: nothing is ever made from it,
 * there is no place to stand on it, and it is not the project's PDF. It is the
 * reading, photographed back.
 *
 * NAMED FOR ITS READ STEP, which is `curateCastFile`'s scheme applied to the one
 * action that has two products. A project can hold two readings — a re-read
 * asking for a different page range branches by design — and a facsimile named
 * from the project stem alone would be the reprint of whichever bank was newest,
 * filed under both rows. Named for the step, a branch gets its own file, and a
 * re-read that REPLACES swaps into the step it re-ran, writes the same path, and
 * rotates its own predecessor aside exactly as a second Generate does.
 *
 * THE TAG IS IN THE NAME FOR `translationCastFile`'s reason: somebody who opens
 * `generated/` should see `Book (facsimile).a1b2c3d4.pdf` and know what they are
 * holding. Nothing reads it back out — the plan that writes the file, the listing
 * that draws its row and the sweep that removes it all ask this function — which
 * is what keeps this app's oldest house rule intact while the name stays legible.
 */
export function facsimileFile(stem: string, stepId: string): string {
  return `${stem} (facsimile).${id8(stepId)}.pdf`;
}

/**
 * Everything made from a replaced step, marked stale — and the step itself
 * marked fresh.
 *
 * TRANSITIVELY, because staleness is inherited the same way the payload was. A
 * curation snapshot made against a reading names blocks by `(page, order)`, and
 * those numbers mean different blocks after the pages are read again; a
 * translation of that curation was a translation of blocks that have moved. Both
 * are stale, and so is anything made from either.
 *
 * NOT THE STEP ITSELF, and it is un-stalled if it was: its payload has just been
 * swapped for a fresh one, which is what "re-run" means. A re-read of a bank that
 * had itself gone stale is exactly how a branch gets brought back to current, and
 * leaving the mark on would tell the user their new reading was old.
 *
 * STALE IS A DISPLAY STATE, NOT A DELETION. Nothing here removes a step or names
 * a file. The stale rows stay in the list, dimmed, clickable and renderable —
 * a translation made from a replaced reading still has its own bank, and that
 * bank is still a true record of what was translated.
 */
export function markStale(ledger: ProjectLedger, id: string): ProjectLedger {
  const marked = new Set(subtree(ledger, id).map((step) => step.id));
  marked.delete(id);
  return {
    ...ledger,
    steps: ledger.steps.map((step) => {
      if (marked.has(step.id)) return step.stale === true ? step : { ...step, stale: true };
      if (step.id !== id || step.stale !== true) return step;
      const { stale: _fresh, ...rest } = step;
      return rest;
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A run that finished: append or replace, decided once
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the main process is holding when a job comes home successfully.
 *
 * THE ID IS SUPPLIED AND IS ONLY USED IF THIS APPENDS, which is the one shape
 * this module can offer for the uuid problem. A landing may turn out to be a
 * re-run, in which case there is no new step and no new id — but the caller
 * cannot know that before asking, and this module has no randomness to mint one
 * with after asking (see the header). So the caller mints one speculatively and
 * this says whether it was used.
 */
export interface LandedRun {
  action: StepAction;
  /**
   * The step this was made FROM — the position CAPTURED WHEN THE JOB WAS
   * ENQUEUED, and not the position now. A person who queued a translation from
   * the reading, then clicked back to look at something else while it ran, asked
   * for a translation of the reading; retargeting it at whatever row they happen
   * to be standing on three hours later would file the run against a parent
   * nobody chose.
   */
  parent: string;
  /** Project-relative, forward slashes. See `LedgerStep.payload`. */
  payload: string;
  params?: LedgerParams;
  createdAt: number;
  /** Minted by the caller, spent only on an append. */
  id: string;
  /** Overrides `labelFor`, for the rare step whose name the catalogue already wrote. */
  label?: string;
}

/** What a landing did — everything main needs to finish the job on disk. */
export interface Landing {
  ledger: ProjectLedger;
  /** The step as it now stands: the one appended, or the one swapped into. */
  step: LedgerStep;
  /** True when an existing step's payload was replaced rather than a new one added. */
  replaced: boolean;
  /**
   * The file the replace displaced, and which nothing in the ledger names any
   * more — or null, which is the ORDINARY answer and not an edge case.
   *
   * A re-read writes `readings/<key>.jsonl`, which is exactly where the previous
   * reading was; a re-translation writes `generated/<book> (en).epub`, which is
   * exactly where the previous translation was. The engine has already dealt with
   * what was there (the bank is archived, the origin is rotated aside), so the
   * step's payload PATH is unchanged and there is nothing left for main to unlink.
   * This is set only when a re-run genuinely moved a payload to a new path, and
   * then only when no surviving step still names the old one — a delete or a
   * destruction that took a file another row points at would leave that row
   * describing nothing.
   */
  displaced: string | null;
  /** Everything this landing marked stale, in creation order, so main can say so. */
  stale: LedgerStep[];
}

/**
 * A finished run, put where it belongs: appended, or swapped into the step it
 * re-ran.
 *
 * ── Why this is one function rather than three lines at each call site ──────
 *
 * Three places record a landing — a reading, a translation, a curation commit —
 * and every one of them owes the same four decisions: is this a re-run
 * (`reRunTarget`), what is it called (`labelFor`), what goes stale (`markStale`),
 * and what file is now nobody's. A rule re-derived at three call sites is a rule
 * that drifts, and the two ways it drifts are both expensive: a call site that
 * forgot `markStale` leaves a translation of a bank that no longer exists looking
 * current, and one that decided "replace" for itself could destroy a payload the
 * user still wanted.
 *
 * ── The replaced step KEEPS ITS PLACE AND ITS DATE ──────────────────────────
 *
 * A re-run swaps a payload; it does not move a row. Stamping the new time on it
 * would put a row claiming to have happened today above rows that happened
 * yesterday, which is precisely the file `parseLedger` refuses to load — the
 * array's order IS the chronology, and re-sorting to fix it would shuffle the
 * list under somebody who is looking at it. What changed is the payload, the
 * params the run recorded, and the label those params compose; where the step
 * sits in the story of this book did not change, because it is the same step.
 *
 * ── And nothing here touches a disk ─────────────────────────────────────────
 *
 * This is only ever called on a run that SUCCEEDED, which is what makes the
 * swap-on-success rule true by construction rather than by remembering it: a
 * failed run never reaches this function, so the old payload is still on disk and
 * still the one the ledger names. `displaced` is the caller's instruction to
 * destroy something, issued after the replacement exists and never before.
 */
export function recordLanding(ledger: ProjectLedger, run: LandedRun): Landing {
  const label = run.label ?? labelFor(run.action, run.params);
  const params = run.params !== undefined && Object.keys(run.params).length > 0
    ? run.params
    : undefined;
  const target = reRunTarget(ledger, { action: run.action, parent: run.parent, params: run.params });

  if (target === null) {
    const step: LedgerStep = {
      id: run.id,
      parent: run.parent,
      action: run.action,
      payload: run.payload,
      retention: RETENTION_OF[run.action],
      createdAt: run.createdAt,
      label,
    };
    if (params !== undefined) step.params = params;
    const next = appendStep(ledger, step);
    // Read back out of the new ledger rather than handed on: `appendStep` clamps
    // a createdAt that ran backwards, and the caller should be told what was
    // actually recorded rather than what was offered.
    return { ledger: next, step: stepOf(next, step.id), replaced: false, displaced: null, stale: [] };
  }

  const swapped: LedgerStep = { ...target, payload: run.payload, label };
  if (params === undefined) delete swapped.params;
  else swapped.params = params;
  const replaced: ProjectLedger = {
    ...ledger,
    // The same rule the append obeys, asked the same way. A re-run of an action
    // that is retained beside you cannot happen — `reRunTarget` never returns an
    // irreplaceable step, which is every action in that table — so this changes
    // nothing today and is written this way so that the two places the pointer is
    // decided cannot come to disagree about what an action does to it.
    position: pointerAfter(ledger, swapped),
    steps: ledger.steps.map((step) => (step.id === target.id ? swapped : step)),
  };
  const marked = markStale(replaced, target.id);
  const stale = subtree(marked, target.id).filter((step) => step.id !== target.id);
  return {
    ledger: marked,
    step: stepOf(marked, target.id),
    replaced: true,
    displaced: target.payload === run.payload || namesPayload(marked, target.payload)
      ? null
      : target.payload,
    stale,
  };
}

/**
 * Does any step still name this file?
 *
 * BY THE WHOLE PROJECT-RELATIVE PATH, never by its last segment. A project holds
 * `archive/Book.pdf`, `generated/Book.pdf` and `working/Book.pdf` at once, and a
 * comparison that had thrown away the layer would report the archived original as
 * still-in-use because a reprint of it happens to share a name — or, in the
 * direction that actually destroys something, would let a delete take one of them
 * believing it had checked.
 */
function namesPayload(ledger: ProjectLedger, payload: string): boolean {
  return ledger.steps.some((step) => step.payload === payload);
}

// ─────────────────────────────────────────────────────────────────────────────
// Deleting
// ─────────────────────────────────────────────────────────────────────────────

/** A delete, decided but not yet done: the ledger after, and what to destroy. */
export interface SubtreeDeletion {
  ledger: ProjectLedger;
  /**
   * Every step whose payload must be destroyed, in creation order.
   *
   * THE CALLER DOES THE FILE WORK. This module does not know a project
   * directory from a hole in the ground, and the same list is what the confirm
   * names to the user before any of it happens.
   */
  removed: LedgerStep[];
}

/**
 * A step and everything made from it, taken out of the ledger.
 *
 * CASCADES RATHER THAN REFUSING, which was the ruling and had a rejected
 * alternative: refuse until the children are deleted one at a time. That is
 * busywork — somebody deleting a branch means the branch — and making them do it
 * leaf-first teaches them nothing they did not already know. What makes the
 * cascade safe is that every casualty is named in the confirm before they agree,
 * which is what `removed` is for.
 *
 * THE ORIGIN IS REFUSED BY NAME. Deleting the import is deleting the project:
 * everything else in the folder was made from it, so there is nothing left to be
 * a project without it. The project ✕ already does that, with its own ceremony
 * and its own accounting of what it costs — and this delete quietly becoming
 * that one is precisely the confusion the ✕'s ceremony exists to prevent.
 */
export function deleteSubtree(ledger: ProjectLedger, id: string): SubtreeDeletion {
  const step = stepOf(ledger, id);
  if (step.parent === null) {
    throw new StepLedgerError(
      `"${step.label}" is the document this project was made from, and it cannot be deleted as a step: `
      + 'everything else here was made from it, so taking it is deleting the project. The ✕ on the project '
      + 'itself does that, and says what it costs first',
    );
  }

  const removed = subtree(ledger, id);
  const gone = new Set(removed.map((casualty) => casualty.id));
  const steps = ledger.steps.filter((candidate) => !gone.has(candidate.id));

  // THE POINTER MOVES TO THE PARENT when it was standing inside what went. It is
  // resolved through `positionOf` rather than read off the field, because an
  // absent pointer is not "no pointer" — it means the newest step, and the newest
  // step is the one most likely to have just been deleted. Left alone, an absent
  // pointer would silently land on whatever is newest among the survivors, which
  // is some unrelated branch rather than the place the deleted work came from.
  const standing = positionOf(ledger);
  const next: ProjectLedger = { steps };
  if (standing !== null && gone.has(standing.id)) next.position = step.parent;
  else if (ledger.position !== undefined) next.position = ledger.position;
  return { ledger: next, removed };
}

/**
 * The files a delete may actually destroy, in creation order, without repeats.
 *
 * ── Why "the removed steps' payloads" is the wrong answer ───────────────────
 *
 * Two steps are allowed to name one file, and in this app they routinely do. A
 * re-read that branched rather than replaced — a different `--skip-pages`, so a
 * different question — leaves two `read` steps, and the readings bank has ONE
 * path: the engine archives the previous one aside and writes the same
 * `readings/<key>.jsonl` again. Delete the older of those two and a naive unlink
 * would destroy the bank the newer one is made of, which is hours of GPU thrown
 * away by a delete aimed at something else entirely.
 *
 * THAT BRANCH IS NOW DELIBERATE RATHER THAN ACCIDENTAL, which is worth writing
 * down because it is what settles whether this function is still needed. It used
 * to happen when a re-read came back with a different page COUNT, which was a
 * proxy nobody chose (see `MINTED_BY_THE_RUN`); it now happens exactly when
 * somebody asks a different question of the same book. The state this defends is
 * therefore more reachable than before, not less — and a translation is the same
 * story in another folder: two `translate` steps into one language from two
 * different parents both name `generated/<book> (en).epub`, because the output
 * path is composed from the stem and the tag and knows nothing about the ledger.
 *
 * So the question is not "what did this subtree name" but "what is left naming
 * it", asked of the ledger AFTER the surgery — and asked by whole project-
 * relative path, for `namesPayload`'s reason.
 *
 * Deduplicated because the caller unlinks what this returns and a path listed
 * twice is a second unlink of something that is already gone, reported as a
 * failure by every filesystem that bothers to answer.
 */
export function orphanedPayloads(deletion: SubtreeDeletion): string[] {
  const orphaned: string[] = [];
  for (const casualty of deletion.removed) {
    if (orphaned.includes(casualty.payload)) continue;
    if (namesPayload(deletion.ledger, casualty.payload)) continue;
    orphaned.push(casualty.payload);
  }
  return orphaned;
}

/**
 * The BANKS a delete destroys, in creation order, without repeats.
 *
 * ── Two kinds of bank, one rule, and only one of them is a payload ──────────
 *
 * A READING'S BANK IS ITS STEP'S PAYLOAD, so `orphanedPayloads` has already
 * decided its fate by the same whole-path rule; it is named here as well so the
 * caller knows the file it is about to unlink IS a bank, and that the engine's
 * in-flight debris beside it goes too (`pendingBeside`).
 *
 * A TRANSLATION'S ANSWERS ARE ITS PAYLOAD TOO, NOW — the records file
 * (`translationRecordsOf`), which `orphanedPayloads` has therefore already decided
 * the fate of by the same whole-path rule. It is named here for the reading's
 * reason: so the caller knows the file it is about to unlink IS a bank, and that
 * the engine's in-flight debris beside it goes too.
 *
 * A TRANSLATION MADE BEFORE RECORDS IS THE CASE THIS FUNCTION WAS WRITTEN FOR, and
 * it is still here. Those steps retain the EPUB a person reads; the bank is the
 * per-block record beside it, named by `params.bank` and by no step's payload
 * anywhere in the project. So `orphanedPayloads` cannot find it and should not
 * learn how — that function reasons over payloads, and a params-reading exception
 * in it would be the first of many. Without this, deleting the English translation
 * left its entire per-block record in `readings/` forever: the same hours of GPU
 * the delete was about, kept for a row that no longer exists.
 *
 * ── Guarded exactly as a payload is ─────────────────────────────────────────
 *
 * Against the ledger AFTER the surgery, by the whole project-relative path, and
 * against what every surviving step MEANS by its bank rather than what it recorded
 * — `translationBankOf`, so a translation that predates the record still defends
 * the file its language composes. Two rows sharing one bank is a state this app
 * can still reach: every translation made before `params.bank` existed composed one
 * name per book per language, so two of them from two different steps name one
 * file, and a delete of either that did not ask would destroy the answers the other
 * one is made of.
 */
export function orphanedBanks(deletion: SubtreeDeletion, key: string): string[] {
  const orphaned: string[] = [];
  for (const casualty of deletion.removed) {
    /*
     * EVERY CHARACTER OF "BANK" ONE STEP CAN HAVE, and a translation can have two
     * over the life of a project: its records file, and — for a row that predates
     * records, or one whose re-translation moved it onto records — the old bank its
     * language composes. Both are asked because a delete that took only one of them
     * would leave the other in `readings/` for a row that no longer exists.
     */
    const banks = casualty.action === 'read'
      ? [casualty.payload]
      : [translationRecordsOf(casualty), translationBankOf(casualty, key)];
    for (const bank of banks) {
      if (bank === null || orphaned.includes(bank)) continue;
      // BOTH CHARACTERS A FILE CAN HAVE, asked of every survivor: the payload a row
      // names and the bank a row means. A reading's bank is the first, a
      // pre-records translation's is the second, and a file that is either to
      // anything still in this project is not a file this delete is about.
      if (namesPayload(deletion.ledger, bank)) continue;
      if (deletion.ledger.steps.some((step) => translationBankOf(step, key) === bank)) continue;
      orphaned.push(bank);
    }
  }
  return orphaned;
}

/**
 * EVERY FILE A DELETE TAKES OFF THE DISK, project-relative, as one list.
 *
 * The payloads nothing still names and the banks nothing still means, joined here
 * rather than swept by two mechanisms — because everything downstream wants the
 * same one list: the delete card NAMES these files before the user agrees,
 * `chainsWithout` strikes the document rows that pointed at them, and the delete
 * unlinks them. A bank destroyed down a second path would be a file the card never
 * mentioned, and a card may not destroy something it did not mention.
 *
 * A UNION AND NOT A CONCATENATION: a reading's bank is in both answers by
 * construction, because it is that step's payload.
 */
export function destroyedBy(deletion: SubtreeDeletion, key: string): string[] {
  const files = orphanedPayloads(deletion);
  for (const bank of orphanedBanks(deletion, key)) {
    if (!files.includes(bank)) files.push(bank);
  }
  return files;
}

/**
 * The engine's in-flight debris beside a bank, by name — the pending replacement
 * and the sidecar that says what it was asked.
 *
 * ── Why a delete has to know about files no step names ──────────────────────
 *
 * A re-read writes its answers into `<bank>.pending` and swaps that over the real
 * bank only when the run completes, so a failed one leaves the old bank untouched
 * and the pending file sitting there as resumable debris — which is the entire
 * point of it (docs/BANK-LIFECYCLE.md §2). A PENDING BANK IS INVISIBLE TO THE
 * LEDGER: steps are minted on success, and success is the moment the pending file
 * stops existing, so no step ever names one and `orphanedPayloads` cannot be the
 * thing that finds it.
 *
 * That leaves exactly one rule for the sweep to learn: when a delete destroys a
 * read step's bank, the half-finished replacement OF that bank goes with it.
 * Debris whose bank is gone is debris about nothing — a resume nothing would ever
 * ask for, keyed to a question no row in the project still asks.
 *
 * ONE FUNCTION FOR BOTH NAMES, and that is the whole reason it is a function
 * rather than two suffixes at the call site: the sidecar's name is the pending
 * file's name plus a suffix, so a call site spelling them separately is a call
 * site where the two can come to disagree about what a pending file is called.
 * The names are the engine's (src/vlm/readings.ts); this is the app reading them.
 */
export function pendingBeside(bank: string): string[] {
  const pending = `${bank}.pending`;
  return [pending, `${pending}.request`];
}

/**
 * The per-type chains with every row naming a destroyed file struck out.
 *
 * ── The ghost row this exists to prevent ────────────────────────────────────
 *
 * A delete used to do half the surgery. It took the steps off the ledger and
 * destroyed their payloads, and left `manifest.documents` — the per-type chains
 * Home's rows are drawn from — still naming the files it had just unlinked. So
 * deleting a translation gave the user a document row for an EPUB that no longer
 * existed, drawn by `summarise` as `missing`, which is the app's way of saying
 * "something went wrong with a file you still have" about a file they had just
 * told it to destroy. They asked for a clean absence and got a broken row.
 *
 * ── Which direction the truth runs ──────────────────────────────────────────
 *
 * THE LEDGER IS THE TRUTH AND THE PER-TYPE ROWS ARE A VIEW OF IT (see
 * `ProjectManifest.ledger` and `currentStandard`), so this takes its instruction
 * from the ledger's answer and never the other way round. It is handed
 * `orphanedPayloads` — the files that are ACTUALLY being destroyed — rather than
 * every removed step's payload, because a file some surviving step still names
 * survives on disk, and a chain row for a file that is still there is a row that
 * is still true.
 *
 * A CHAIN LEFT WITH NO STEPS IS DROPPED ENTIRELY, and that is what `summarise`
 * already means by it: the loop that draws the rows takes the LATEST step of each
 * record and skips a record that has none, so an empty chain is a document the
 * app will never draw again. `ProjectTypeRecord.steps` says the same thing in the
 * type — "never empty; a type with no origin is not a type this project has" — so
 * keeping the husk would leave the catalogue asserting the project has an EPUB
 * with nothing behind it, and `recordStep` rebuilds the record from nothing the
 * moment another file of that type lands.
 *
 * BY THE WHOLE PROJECT-RELATIVE PATH, `namesPayload`'s rule, and it matters more
 * here than anywhere: `archive/Book.pdf`, `working/Book.pdf` and
 * `generated/Book.pdf` are three documents in one project, and a comparison that
 * had thrown away the layer would strike the scan's row for a delete aimed at a
 * reprint.
 */
export function chainsWithout(
  documents: readonly ProjectTypeRecord[],
  destroyed: readonly string[],
): ProjectTypeRecord[] {
  const gone = new Set(destroyed);
  const kept: ProjectTypeRecord[] = [];
  for (const record of documents) {
    const steps = record.steps.filter((step) => !gone.has(step.file));
    if (steps.length === 0) continue;
    // Rebuilt only where something changed, so a project whose delete touched
    // one type hands back the very same objects for every other one.
    kept.push(steps.length === record.steps.length ? record : { ...record, steps });
  }
  return kept;
}

/**
 * The sentence the confirm says, in the retention rule's own terms.
 *
 * NOT "ARE YOU SURE?". The three retentions are three genuinely different
 * losses, and a confirm that did not say which one this is trains people to
 * click through it — which is how somebody loses a curation while dismissing
 * what they assumed was the dialog about a rendering.
 *
 * The reasons are quoted from `WHY_IMPORTED`, `WHY_HANDMADE` and
 * `WHY_MODEL_PASS` rather than written again here, because those constants exist
 * so that every warning in this app says the same words about the same loss.
 */
export function deleteCost(step: LedgerStep): string {
  switch (step.retention) {
    case 'irreplaceable':
      /*
       * A METADATA ROW IS THE ONE IRREPLACEABLE STEP WHOSE DELETE DOES NOT TAKE
       * THE THING BACK, and saying so is the whole reason it has a sentence of its
       * own. The values were written into the document when the user pressed
       * Apply; what this row holds is the RECORD of that, which is what an export
       * replays. Deleting it leaves the document exactly as it is and stops later
       * exports carrying the correction — which is a real loss and a different one
       * from "your work is gone", and a confirm that said the second about the
       * first would be lying to somebody about to click it.
       */
      if (step.action === 'metadata') {
        return `Discarding “${step.label}” destroys ${WHY_HANDMADE}. The document keeps the values `
          + 'you typed — this is the record of them, so what is lost is that anything made from '
          + 'here stops carrying them.';
      }
      if (step.action === 'import') {
        /*
         * AN IMPORT WITH A PARENT IS A MINT (see `mintedStep`), and the two owe a
         * person completely different sentences. The old one said "the only copy
         * of this document Foundry knows of — nobody knows where it came from",
         * which is false twice over about a minted PDF: Foundry knows exactly
         * where it came from, and it is not the only copy of anything — the
         * photographs are, and they are staying.
         *
         * WHAT IS ACTUALLY LOST IS THE READINGS. A re-mint is a new document and
         * nothing hung off this one follows it across, so the honest warning is
         * about the work done ON these pages rather than about the pages.
         */
        return step.parent === null
          ? `Discarding “${step.label}” destroys ${WHY_IMPORTED}. There is nowhere to fetch it back from.`
          : `Discarding “${step.label}” destroys the pages you minted and every reading hung off them. `
            + 'The photographs and their recipe stay, so you can mint again — but a new mint is a new '
            + 'document, and readings do not follow it.';
      }
      return `Discarding “${step.label}” destroys ${WHY_HANDMADE}. No run remakes it, at any price.`;
    case 'expensive':
      return `Discarding “${step.label}” costs a paid run to undo: ${WHY_MODEL_PASS}.`;
    default:
      return `Discarding “${step.label}” costs nothing — it is made again from what is still here, for free.`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The two views the app draws
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The newest non-stale step of each action along the position's ancestry.
 *
 * ── The most delicate thing in this file ────────────────────────────────────
 *
 * The per-type document rows — "the PDF", "the EPUB" — and the ledger must not
 * be two sources of truth. THE LEDGER IS THE TRUTH, and the rows are derived
 * from this. That means this function decides which reading is "the" reading and
 * which translation is "the" translation for everything downstream: what a
 * Generate renders, what the shelf shows, what a new job takes as input.
 *
 * ALONG THE ANCESTRY, and not across the whole ledger, which is the part that is
 * easy to get wrong and cheap to describe: standing on the Hungarian translation,
 * "the translation" is the Hungarian one — the English one is a sibling, made
 * from the same reading, and it is not on the path from the import to where the
 * user is standing. A scan of the whole list would pick whichever happened to be
 * newest and would repaint somebody's screen with a language they had stepped
 * away from.
 *
 * NON-STALE ONLY, because a stale step is a payload whose ancestor has been
 * replaced under it. It is still renderable and still listed — that was the
 * ruling — but it is not the current standard of anything, and derived rows that
 * pointed at it would be showing a reading of a bank that no longer exists.
 *
 * The ancestry runs origin-first, so the LAST match is the newest by
 * construction; no comparator, and no dependence on the array's own order.
 */
export function currentStandard(ledger: ProjectLedger): Partial<Record<StepAction, LedgerStep>> {
  const standing = positionOf(ledger);
  if (standing === null) return {};
  const standard: Partial<Record<StepAction, LedgerStep>> = {};
  for (const step of ancestry(ledger, standing.id)) {
    if (step.stale === true) continue;
    standard[step.action] = step;
  }
  return standard;
}

/**
 * WHERE A WALK UP FROM THE POSITION STOPS — the edge of one bank's story.
 *
 * ── The rule both views were spelling separately ────────────────────────────
 *
 * Two questions are answered by walking the position's ancestry upward and taking
 * the first thing found: WHICH CURATION is in effect, and WHICH BANK the row is
 * about. They walk the same chain and they stop in the same places, and the
 * places are a `read` and the `import` — because a reading is where a bank's
 * story BEGINS. Anything above a read belongs to a different pass over the pages:
 * a snapshot from up there names blocks by `(page, order)` numbers that mean
 * different blocks on this side of it (see `ProjectReading`), and a bank from up
 * there is somebody else's reading of the same book.
 *
 * A TABLE, and the same shape as `RETENTION_OF` for the same reason. The two
 * views used to state the stopping rule as a literal `if` apiece, and a third
 * would arrive the day another action is added — at which point one of them
 * learns the new boundary and the other does not, and the two disagree about
 * where one reading's story ends while both look correct.
 */
/**
 * Is the position an ARRIVAL — a row the project began at, rather than
 * something made out of an earlier row?
 *
 * ── ONE TABLE, TWO VOCABULARIES, AND DELIBERATELY NOT A SECOND TABLE ────────
 *
 * `BOUNDS_THE_WALK` below answers this in the walker s words: a walk up a chain
 * stops at a row that was not made from anything. `stages.ts` asks the same
 * question in the reader s words — is there a book at this position, or is this
 * where the project came in? — and a step bounds the walk exactly when it is an
 * arrival. Same fact, so it reads the same table; a second table with the same
 * two `true`s in it would be a second answer waiting to disagree the day a
 * third arrival kind appears.
 *
 * ── NULL IS NOT AN ARRIVAL, WHICH KEEPS AN EXISTING PROMISE ─────────────────
 *
 * `stages.ts` documents that a step this window has not read yet answers TRUE to
 * "is there a book here", deliberately, so that a project does not have every
 * act greyed for the first moment it is on screen. Answering `false` here is
 * what preserves that: the caller negates this, and null must not become "you
 * are standing on an arrival".
 */
export function standsOnAnArrival(step: LedgerStep | null): boolean {
  return step !== null && BOUNDS_THE_WALK[step.action];
}
const BOUNDS_THE_WALK: Readonly<Record<StepAction, boolean>> = {
  import: true,
  /*
   * A BOUNDARY, exactly as an import is: it is the bottom of its chain. A walk
   * up looking for a bank or a curation that reached a capture row has reached
   * the beginning of the project, and must stop there rather than fall off it.
   */
  capture: true,
  read: true,
  curate: false,
  translate: false,
  /*
   * A METADATA ROW IS TRANSPARENT TO THIS WALK. The questions it answers are
   * "which bank" and "which curation", and a row that recorded a title says
   * nothing about either — standing on the reading with a metadata edit between
   * you and it must still find that reading. It is emphatically not a boundary:
   * a boundary means "a different pass over the pages begins here", which is a
   * claim about blocks that this action never makes.
   *
   * The metadata chain has a walk of its own (`metadataInEffect`) and it does not
   * come through here, for the reason stated there.
   */
  metadata: false,
  /*
   * AN EDIT ROW IS TRANSPARENT TO THIS WALK TOO, and for a reason that is nearly
   * the metadata one and not quite. It says nothing about which bank or which
   * curation — it says what the BLOCKS of the bank below it now read — so
   * standing on an edit must still find the reading underneath it, or the pane
   * would have no book to replay the ops over at all.
   *
   * The edit chain has a walk of its own (`editsInEffect`) and it is bounded by a
   * read for the reason this table's header gives: an op names a block id, and a
   * block id from before a re-read names a block of somebody else's pass over the
   * pages.
   */
  edit: false,
};

/**
 * The nearest step of this action on the position's ancestry, or null.
 *
 * The walk is upward from where the user is standing, so a step of the wanted
 * action is answered even when it IS the boundary — that is how a `read` finds
 * itself — and the boundary otherwise ends the search rather than letting it
 * continue into a pass this row is not about. A sibling is correctly never found:
 * a curate step hanging off the reading is not on the path from the import to a
 * position standing on the reading itself.
 */
function nearestUpward(
  ledger: ProjectLedger,
  wanted: StepAction,
  /**
   * WHERE THE WALK STARTS, when it starts somewhere other than the position.
   *
   * A landing casts a book FOR ONE STEP — a save's own book, a translation's — and
   * the pointer at that moment is wherever the person happens to be standing
   * (`RETAINED_BESIDE_YOU`, and a queue that runs minutes later). A plan keyed to a
   * step therefore cannot ask the position which corrections or which records are
   * in effect: it would render the book as it is NOW under a name that says as it
   * was THEN. Every one of these questions is "the nearest such row on the way up
   * from HERE", and here is an argument.
   *
   * Null and absent both mean the position, which is what every viewer asks.
   */
  from: LedgerStep | null = null,
): LedgerStep | null {
  const standing = from ?? positionOf(ledger);
  if (standing === null) return null;
  const chain = ancestry(ledger, standing.id);
  for (let at = chain.length - 1; at >= 0; at -= 1) {
    const step = chain[at]!;
    if (step.action === wanted) return step;
    if (BOUNDS_THE_WALK[step.action]) return null;
  }
  return null;
}

/**
 * The reading a rendering AT THE POSITION is made from — the step that owns the
 * bank — or null for a project with no reading on the path.
 *
 * ── The lie this exists to end ──────────────────────────────────────────────
 *
 * A read step's `payload` has always been the authority on where its bank lives,
 * and everything else COMPOSED that path from the project key instead of asking
 * the step: `readings/<key>.jsonl`, one per project, forever. That was true while
 * there was only ever one bank, and a re-read with different `--skip-pages`
 * branches by design (`MINTED_BY_THE_RUN`) — so a project could hold two `read`
 * steps and one file, the older of them describing a bank that had been written
 * over from under it. Standing on the older row and pressing Generate rendered
 * the newer reading, silently, with nothing on screen admitting the swap.
 *
 * So the plan asks the row. A branch mints its own bank path and the step records
 * it; every project that existed before this keeps `readings/<key>.jsonl`, which
 * is exactly what its one read step already says, so nothing on any disk moves.
 *
 * NULL FALLS BACK TO THE COMPOSED PATH, and the caller is where that happens
 * rather than here, because composing it needs the project key and this module
 * knows nothing about projects. It is the honest answer for two states: a project
 * with no reading at all, and a position standing on the import — the revert row,
 * which is about the untouched original rather than about any bank.
 */
export function readingInEffect(
  ledger: ProjectLedger,
  /** The step to walk up from, or null for the position. See `nearestUpward`. */
  at: LedgerStep | null = null,
): LedgerStep | null {
  return nearestUpward(ledger, 'read', at);
}

/**
 * The curation snapshot a rendering AT THE POSITION is made with, or null when
 * the answer is the live overlay.
 *
 * ── This is what makes the pointer worth moving ─────────────────────────────
 *
 * Every rendering in this app is `render(bank + overlay)`. Which overlay was
 * never a question before, because there was one: `overlays/<key>.json`, the
 * mutable working state of the block editor. A curation step freezes a copy of
 * that file, and the whole point of freezing one is to be able to stand on it and
 * get the book as it was — so the pointer has to decide which of them a Generate
 * reads, or the frozen snapshots are files nobody can ever see the effect of.
 *
 * THE ANSWER IS FOUND BY WALKING UP FROM THE POSITION, and the walk stops at a
 * reading. Standing on a save gives that save; standing on the reading gives the
 * live overlay, because the reading step is where live editing happens (a curate
 * step made from that reading is a SIBLING of wherever the user is standing, not
 * an ancestor, so it is correctly not found). A chain of saves gives the newest
 * one on the path, which is the one being stood on.
 *
 * A TRANSLATE STEP FALLS THROUGH TO ITS NEAREST ANCESTOR THAT HAS ONE, and that
 * is now exactly right rather than an approximation. It used to be the whole of
 * what standing on a translation did — the rendering was the book it was
 * translated from, in the language it was translated OUT of, which is a German
 * book for somebody who clicked the row labelled *Translated (Hungarian)*. What
 * changed is not this walk: a translation bank carries no page and no order, so
 * nothing can ever render from one, and the curation that applies to the blocks
 * is still the one the translation was made under. What changed is that a
 * Generate from there no longer STOPS at the rendering — it feeds it to a
 * translate stage (`renderPipeline`, shared/pipeline.ts), and this answer is the
 * first half of that pipeline rather than a substitute for the second.
 *
 * NULL IS THE ORDINARY ANSWER. A project nobody has committed a curation in has
 * no `curate` step anywhere, so every position resolves to the live overlay and
 * nothing about this app's behaviour changes.
 */
export function curationInEffect(
  ledger: ProjectLedger,
  /** The step to walk up from, or null for the position. See `nearestUpward`. */
  at: LedgerStep | null = null,
): LedgerStep | null {
  // The walk and its stopping places are `nearestUpward`'s, shared with
  // `readingInEffect` rather than spelled twice: both questions are "the nearest
  // one of these on the way up", and both stop at the reading whose blocks the
  // answer would be about. See `BOUNDS_THE_WALK`.
  return nearestUpward(ledger, 'curate', at);
}

/**
 * ROWS THAT DISPLAY THEMSELVES — the other half of the pointer's job, and the
 * half that is NOT the walk above.
 *
 * ── The ruling, in one line ─────────────────────────────────────────────────
 *
 * SNAPSHOTS DISPLAY THEMSELVES AND LOCK; EVERY OTHER ROW DISPLAYS THE LIVE
 * OVERLAY AND EDITS. Standing on a `curate` puts that frozen copy on the pages
 * and takes correcting away, because the whole point of clicking an old save is
 * to see the book as it was then. Standing on anything else — the import, the
 * reading, a translation — puts the LIVE corrections on the pages and lets a
 * person work.
 *
 * ── Why a `translate` row is a live row, which is the line that changed ─────
 *
 * A translation used to be shown frozen, because the question asked of the
 * ledger was `curationInEffect` and a translation made FROM a save resolves to
 * that save. It made the editor read-only one row below the save, and it made
 * the user's own walkthrough impossible: translate from a save, and correcting
 * this book is off forever after — every row below it inherits the freeze, and
 * the only way back to a working editor is to abandon the branch you just made.
 *
 * The mistake was treating two different things as one. A TRANSLATE ROW IS A
 * STATE OF THE TEXT, NOT A SNAPSHOT OF CORRECTIONS. What it retained is a bank
 * of translated blocks; it froze nobody's strikes and there is no copy of any
 * corrections in it to be shown or protected. So the corrections pane there
 * shows the corrections that are actually being worked on — the live ones — and
 * striking a paragraph while standing on a translation is the ordinary gesture
 * the walkthrough is made of: strike, commit, and the commit is a row under the
 * translation.
 *
 * ── Why this is not `curationInEffect` with a flag ──────────────────────────
 *
 * Because it is a different question and the walk is the proof. DISPLAY IS
 * ABOUT WHICH ROW YOU CLICKED; RENDER IS ABOUT WHAT STATE IS IN EFFECT — and
 * only the second one has anything to walk. A rendering at a translation is
 * made with the curation the translation was taken under, which is a fact three
 * rows up the chain and has to be found; what the pane draws is a fact about the
 * row itself and is answered by looking at it. Folding them into one function
 * with a `forDisplay` argument would put a boolean where the difference in
 * meaning is, and the day somebody passed the wrong one the failure would be
 * silent in both directions.
 *
 * WHAT GENERATE RENDERS IS UNCHANGED BY ANY OF THIS. `renderingOverlay`
 * (electron/projects.ts) and `renderPipeline`'s `curation` (shared/pipeline.ts)
 * still ask `curationInEffect`, so a Generate is still made with the committed
 * snapshot in effect and the dialog still names it. That leaves exactly one
 * place where the pane and the Generate differ — standing on a translation with
 * strikes nobody has committed, the pages show them and a Generate of the
 * translation does not — and it is resolved the way this whole app resolves it:
 * commit, and the commit is a row (docs/TRANSLATION-STEPS.md §4).
 *
 * A TABLE, for `RETAINED_BESIDE_YOU`'s reason: the day a fifth action arrives its
 * author has to say whether that row is a frozen copy of somebody's decisions —
 * which is a question with a real answer, and one that a literal
 * `action === 'curate'` at a call site would let them skip. (A read-only LOCK
 * used to derive from this same table so the two could not drift; there is no
 * lock any more, because standing on any step is a replay of that chain and
 * there is nothing to diverge — docs/RENDERER.md §7.)
 */
const DISPLAYS_ITSELF: Readonly<Record<StepAction, boolean>> = {
  import: false,
  // A capture froze nobody's corrections — there is no book yet for corrections
  // to be about. `import`'s answer, for `import`'s reason.
  capture: false,
  read: false,
  curate: true,
  translate: false,
  /*
   * A METADATA ROW FROZE NOBODY'S CORRECTIONS, so there is nothing of that kind
   * to show and nothing to lock. It is the `translate` answer for the `translate`
   * reason: what it retained is a record of six typed fields, not a copy of
   * anybody's strikes, so the pane goes on drawing the live ones and a person
   * standing there can still work.
   */
  metadata: false,
  /*
   * AN EDIT ROW FROZE NOBODY'S CORRECTIONS EITHER. What it retained is a list of
   * ops against block ids in the book file — a different document, a different
   * addressing scheme and a different surface from the block editor's overlay —
   * so there is no snapshot of anybody's strikes to show and nothing to lock. The
   * scan's editor goes on drawing the live corrections beside it, which is the
   * honest picture: the two surfaces are not editing the same thing yet, and R6
   * is where one of them stops existing.
   */
  edit: false,
};

/**
 * The curation snapshot the block editor SHOWS at the position, or null when the
 * answer is the live overlay — the sibling of `curationInEffect` above, and much
 * the simpler of the two on purpose.
 *
 * There is no walk here and there should not be one. See `DISPLAYS_ITSELF` for
 * the whole of the reasoning; the short of it is that the walk belongs to the
 * render, because "what state is in effect" is a fact about a chain, and this is
 * "what did you click", which is a fact about one row.
 *
 * NULL IS THE ORDINARY ANSWER, as it is for every question in this family: a
 * person correcting a scan stands on the reading, and a person who has just
 * pressed Save is still standing on the reading (`RETAINED_BESIDE_YOU`).
 */
export function displayedCuration(ledger: ProjectLedger): LedgerStep | null {
  const standing = positionOf(ledger);
  if (standing === null) return null;
  return DISPLAYS_ITSELF[standing.action] ? standing : null;
}

/**
 * The translation a Generate AT THE POSITION produces again, or null when the
 * position is one a single run of `vlm-convert` answers.
 *
 * ── The third question the one walk answers ─────────────────────────────────
 *
 * `readingInEffect` asks which bank, `curationInEffect` asks which overlay, and
 * this asks whether there is a SECOND STAGE at all: standing on a `translate`
 * finds itself, standing on a `curate` made under one finds the translation above
 * it, and everything else finds nothing — because the walk stops at a `read`, and
 * anything above a read belongs to a different pass over the pages. So a project
 * that has never been translated cannot reach the pipeline at all, and neither
 * can a position under the reading in a project that has.
 *
 * IT IS THE STEP AND NOT ITS PAYLOAD, which is the distinction that keeps the
 * caller honest. What this row supplies is what the translate stage is ASKED —
 * `--to` from `params.language` and `--bank` from `params.bank` — and never where
 * the run writes: that is decided by `translationTarget` against the parent the
 * product is filed under, which for a re-render of this very row is this row's
 * own parent. Handing back the payload here would invite a caller to write into
 * it directly, which is right for a re-render of the translation and wrong for a
 * curation made under it — a different book, and a row that would then be lying
 * about its own contents.
 *
 * The refusal for a translation OF a translation is not here: this answers what
 * the ledger says, and what this app will and will not run from it is
 * `renderPipeline`'s to say (shared/pipeline.ts).
 */
export function translationInEffect(
  ledger: ProjectLedger,
  /** The step to walk up from, or null for the position. See `nearestUpward`. */
  at: LedgerStep | null = null,
): LedgerStep | null {
  return nearestUpward(ledger, 'translate', at);
}

/**
 * EVERY EDIT ON THE PATH FROM THIS READING TO WHERE YOU ARE STANDING, oldest
 * first — the chain a book is replayed through.
 *
 * ── Why this is a list where its neighbours are a single answer ─────────────
 *
 * Because an op file is a DELTA (docs/RENDERER.md §3). The other questions in this
 * family — which bank, which curation, which translation — each have exactly one
 * answer because each names a whole state of something. An edit names a change,
 * and a change does not supersede the change before it: strike a running head on
 * Monday, retype a paragraph on Tuesday, and both are in effect on Wednesday. So
 * every row on the way comes back and the REPLAY decides what the book says
 * (`replayOps`, shared/ops.ts), exactly as `metadataInEffect` hands back every
 * patch and lets the merge decide the title.
 *
 * ── AND IT IS THE ANCESTRY, WHICH IS WHERE IT PARTS COMPANY WITH METADATA ───
 *
 * A metadata row is retained beside you, so it hangs off the position as a CHILD
 * and an ancestry walk would find nothing — which is why that function asks
 * "whose parent is on the path" instead. An edit row moves the pointer onto
 * itself (`RETAINED_BESIDE_YOU`), so it is on the path by construction, and the
 * ancestry is exactly right: the chain is the branch of the story you are
 * standing in, and an edit made on a branch you stepped off is not part of this
 * book any more than a translation on that branch is.
 *
 * ── BOUNDED BY THE READING, and that is the load-bearing part ───────────────
 *
 * `BOUNDS_THE_WALK`'s own rule, and an op is the sharpest case for it in the app.
 * An op names a BLOCK ID, ids are minted from a bank's answers, and the engine
 * archives a completed bank and reads every page again on a re-read — so
 * `b7-14` above a read and `b7-14` below it are two different paragraphs. Ops from
 * the far side would strike the wrong blocks with nothing on screen admitting it,
 * which is the failure `ProjectReading` exists to describe. The walk stops at the
 * read, and a chain that survived a re-read simply is not in effect.
 *
 * OLDEST FIRST, because replay is order-dependent and the order is the order they
 * were made. The chain runs origin-first, so walking it backwards and unshifting
 * puts them in the order the person did them.
 */
export function editsInEffect(
  ledger: ProjectLedger,
  /** The step to walk up from, or null for the position. See `nearestUpward`. */
  at: LedgerStep | null = null,
): LedgerStep[] {
  const standing = at ?? positionOf(ledger);
  if (standing === null) return [];
  const chain = ancestry(ledger, standing.id);
  const found: LedgerStep[] = [];
  for (let walker = chain.length - 1; walker >= 0; walker -= 1) {
    const step = chain[walker]!;
    if (step.action === 'edit') found.unshift(step);
    else if (BOUNDS_THE_WALK[step.action]) break;
  }
  return found;
}

/**
 * WHERE A WALK FOR A REPLAY STOPS — one place further down than every other one.
 *
 * ── Why a transform is a boundary here and nowhere else ─────────────────────
 *
 * `BOUNDS_THE_WALK` answers "which bank" and "which curation", and a translate
 * row says nothing about either — it is transparent there, correctly, because a
 * translation of a reading is still about that reading's pages.
 *
 * THE REPLAY IS A DIFFERENT QUESTION, and it is not about provenance at all: it
 * is *"what has been done to the book file I am about to draw"*. When a translate
 * lands, main materialises a DERIVED book file — parent book file + chain ops +
 * records, same ids, struck rows already absent, text already replaced
 * (docs/RENDERER.md §4) — and every position under that translation reads it,
 * *"so replay is always one short hop"*. The ops above the translation are IN
 * that file. Replaying them again over it would strike rows that are already
 * gone, retype paragraphs the derived file already carries in another language,
 * and report the rest as missing: the same edits applied twice, on a document
 * that was made by applying them once.
 *
 * So the boundary is a fact about what is BAKED IN, and it belongs to the walk
 * that feeds a replay rather than to the one that names a bank. A table of its
 * own, spread from the other so that a new action gets a decision in both places
 * rather than a default in one, and `translate` is the single line that differs.
 */
const BOUNDS_THE_REPLAY: Readonly<Record<StepAction, boolean>> = {
  ...BOUNDS_THE_WALK,
  translate: true,
};

/**
 * The ops still to be replayed at a position — every edit made SINCE the nearest
 * book file on the way up, oldest first.
 *
 * ── The difference from `editsInEffect`, which is not a subset relation ─────
 *
 * `editsInEffect` answers "what has this person applied on the way here", and
 * that is the right question for a refusal: a rendering built from the bank
 * carries none of those changes whether a translation stands between them or not,
 * so `refuseOverEdits` counts them all. This answers "what does the book file at
 * this position not already know", which is the question a REPLAY asks — and the
 * two differ by exactly the edits that were materialised into a derived file when
 * a transform landed.
 *
 * A POSITION WITH NO TRANSLATION ON ITS PATH GETS THE SAME LIST FROM BOTH, which
 * is every position in a project nobody has translated: the walks are identical
 * until a translate row appears.
 */
export function editsSinceTransform(
  ledger: ProjectLedger,
  /** The step to walk up from, or null for the position. See `nearestUpward`. */
  at: LedgerStep | null = null,
): LedgerStep[] {
  const standing = at ?? positionOf(ledger);
  if (standing === null) return [];
  const chain = ancestry(ledger, standing.id);
  const found: LedgerStep[] = [];
  for (let walker = chain.length - 1; walker >= 0; walker -= 1) {
    const step = chain[walker]!;
    /*
     * ── A `curate` ROW IS ON THIS WALK, AND IT IS THE ONE PLACE IT IS ──────────
     *
     * This is the only walk in the app that asks *"what has been done to the book
     * file I am about to draw"*, and a save made before the op grammar existed is
     * an answer to it: a file of decisions about the same blocks, written in the
     * coordinates the bank uses instead of in block ids. The reader re-keys it
     * through the book file's own `src` column and replays it as ops
     * (`rekeyCuration`, shared/curate-bridge.ts; docs/RENDERER.md §8).
     *
     * IT IS NOT ADDED TO `editsInEffect` BESIDE IT, deliberately. That one feeds
     * a REFUSAL — a rendering built from the bank carries none of these changes —
     * and a facsimile is the only rendering left that it refuses. A facsimile
     * reprints the scan's photographed pages and has never carried a curation
     * either: the old route dropped `--overlay` on the floor for exactly that
     * reason. So making a save count there would refuse a reprint that was always
     * allowed, on the strength of a change of spelling.
     *
     * A CURATE ROW IS ONLY EVER ON AN ANCESTRY SOMEBODY CHOSE. A save does not
     * move the pointer (`RETAINED_BESIDE_YOU`), so it hangs BESIDE the reading
     * rather than above it, and this walk finds one only when the person is
     * standing on that row or on something below it — which is when they have
     * asked to see the book as that save left it.
     */
    if (step.action === 'edit' || step.action === 'curate') found.unshift(step);
    else if (BOUNDS_THE_REPLAY[step.action]) break;
  }
  return found;
}

/**
 * EVERY METADATA EDIT MADE ANYWHERE ON THE WAY TO WHERE YOU ARE STANDING, in the
 * order they were made.
 *
 * ── The hole this closes ────────────────────────────────────────────────────
 *
 * An export is cast fresh from the bank, and the bank knows nothing about the
 * title somebody typed into the dialog last week — that went into the OPF of the
 * working tree, which is not an input to a cast. So the app wrote a book, filed
 * it in `final/`, and the corrections were silently absent from it. The rows are
 * the durable record precisely so that materialisation can replay them, and this
 * is what it replays.
 *
 * ── Why this is a LIST and not the usual `nearestUpward` ────────────────────
 *
 * Every other question in this family is "which one is in effect" and has exactly
 * one answer. This one accumulates: an edit that set the title and a later one
 * that set the author are both in effect, and neither supersedes the other. So
 * every row comes back and the MERGE decides field by field — newest value wins —
 * which is `mergedMetadata` below, kept separate because merging patches is a
 * different question from finding them and only one of the two needs a ledger.
 *
 * ── AND WHY IT IS NOT THE ANCESTRY, WHICH IS THE WHOLE TRAP HERE ────────────
 *
 * A metadata row is RETAINED BESIDE YOU: pressing Apply leaves the pointer where
 * it was, so the row it minted is a CHILD of the position and never one of its
 * ancestors. An ancestry walk therefore finds NOTHING in the ordinary case — edit
 * the title standing on the reading, export from the reading, and the export
 * carries nothing at all, which is the exact silence this unit exists to end,
 * reintroduced by the one function meant to end it.
 *
 * So the question is asked the way the gesture actually happened: A METADATA ROW
 * IS IN EFFECT WHEN THE STEP IT WAS MADE FROM IS ON THE PATH FROM THE IMPORT TO
 * WHERE YOU ARE. That is "everything you typed while standing anywhere you have
 * passed through", which is what a person means by "the book's title", and it
 * still refuses the things it should: an edit made while standing on the English
 * translation hangs off THAT row, so exporting the Hungarian one — a sibling,
 * made from the same reading — does not carry it. Its parent is not on the path.
 *
 * ── And why it is not bounded by the reading ────────────────────────────────
 *
 * `nearestUpward` stops at a `read` because a bank's story begins there: a
 * snapshot from above it names blocks that mean something else on this side. A
 * TITLE MEANS THE SAME THING ON BOTH SIDES OF A READING. Reading the pages again
 * does not un-say what the book is called, so the path runs to the import, and a
 * correction made before the re-read is still the correction.
 *
 * IN THE ARRAY'S ORDER, which is the chronology by the ledger's own rule
 * (`parseLedger` refuses a file whose rows run backwards). That makes "newest
 * wins" a plain left-to-right fold with no comparator — and it has to be the
 * array rather than the chain, because these rows hang off several different
 * parents and the chain cannot order them against each other.
 */
export function metadataInEffect(
  ledger: ProjectLedger,
  /**
   * Where the path ends — the step a JOB captured when it was enqueued, or null
   * for the position now.
   *
   * The job's own parent is the honest answer for an export: it is where the
   * person was standing when they pressed the button, and a pointer move made
   * while the job waited in the queue must not change which corrections the book
   * that comes out of it carries. Same rule as `Job.parentStep`, one layer down.
   * An id this ledger no longer holds falls back to the position, on `landStep`'s
   * reasoning: the row was deleted while the run was going, and refusing to
   * describe the product is worse than describing it from where the user is.
   */
  from: string | null = null,
): LedgerStep[] {
  const standing = (from === null ? null : ledger.steps.find((step) => step.id === from))
    ?? positionOf(ledger);
  if (standing === null) return [];
  const path = new Set(ancestry(ledger, standing.id).map((step) => step.id));
  return ledger.steps.filter((step) => (
    step.action === 'metadata' && step.parent !== null && path.has(step.parent)
  ));
}

/**
 * THE PATCH A PRODUCT CARRIES, out of the patches its ancestry recorded — newest
 * value per field, and one kind of document only.
 *
 * ── Newest wins, field by field ─────────────────────────────────────────────
 *
 * Two edits that both set the title are one field corrected twice, and the second
 * one is what the book is called. Two edits that set different fields are both in
 * effect. That is the whole rule, and it is a fold rather than a "last patch
 * wins" because the alternative would let an edit that touched only the publisher
 * throw away the title an earlier one set.
 *
 * ── AND ONE KIND ONLY, WHICH IS THE PART WORTH ARGUING ──────────────────────
 *
 * A project holds a scan and the book cast from it, and the metadata dialog edits
 * whichever the position is showing — so an import row's edit is about the PDF's
 * Info dictionary and a read row's is about the package. They are two documents'
 * records with two vocabularies (`author` against `dc:creator`; `subject` and
 * `keywords` exist for one of them only), and the honest thing to do with a
 * `pdf` patch while making an EPUB is to leave it alone. Carrying the title
 * across because both formats happen to spell that one field the same way would
 * be this app moving somebody's words between two documents on the strength of a
 * coincidence in two file formats.
 *
 * PURE, AND IT TAKES THE CONTENTS RATHER THAN THE STEPS: the values live in
 * payload files, reading files is main's job, and deciding what wins is exactly
 * the kind of rule this module exists to keep where a test can reach it.
 */
export function mergedMetadata(
  patches: readonly MetadataPatch[],
  kind: MetadataPatch['kind'],
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const patch of patches) {
    if (patch.kind !== kind) continue;
    for (const [field, value] of Object.entries(patch.fields)) {
      // A blank is not a value. The engine refuses one by name — an empty
      // `dc:title` is a book claiming to be called nothing — and a patch file
      // somebody hand-edited must not be able to turn an export into a refusal.
      if (typeof value !== 'string' || value.trim().length === 0) continue;
      merged[field] = value;
    }
  }
  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE PANES SHOW AT THE POSITION
//
// The pointer's first job, written down in docs/STEP-LEDGER.md and never built:
// "What do the viewers show? The rendering of the position step. Moving the
// pointer repaints the open tabs of that project." What the app actually did was
// a third of that. A pointer move re-read the CURATION and left the blocks under
// it exactly where they were — so moving between two readings drew one reading's
// corrections over the other reading's boxes, with nothing on screen admitting
// the swap — and a move onto the import, or onto any row at all while the pane
// was not in the block editor, did nothing whatsoever. Somebody with a two-step
// history clicked both of their own rows and watched the app sit there, which is
// the whole of the complaint this exists to answer.
//
// SO THE QUESTION IS ASKED ONCE, HERE, AS ONE VALUE, and the renderer's job
// becomes "make the pane match this" rather than "work out what that click
// meant". Three surfaces were about to need the same derivation — the pane, the
// notice that admits when a move cannot be shown, and whatever phase B puts on a
// read row — and a rule re-derived at each of them is a rule that drifts, which
// is the reasoning every table in this file is built on.
//
// AND IT IS THE SEAM docs/DERIVED-BOOK.md §6 PHASE B NEEDS. A read row is going
// to stop meaning "the scan with the model's outlines over it" and start meaning
// "the reflowed HTML document". That changes WHAT this answers; it must not
// change HOW a pointer move drives a pane. Everything on the renderer side reads
// these fields and none of it re-reads the ledger, so the day the flowing surface
// lands, the fields grow and the effect that drives the panes does not move.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ROWS THAT ARE A BOOK OF THEIR OWN — a table, for `DISPLAYS_ITSELF`'s reason.
 *
 * ── What this replaced, and what that cost ──────────────────────────────────
 *
 * This used to be `SHOWN_ELSEWHERE`, and its one `true` meant "a pane cannot open
 * this row's payload". That was never a fact about translations; it was a fact
 * about the app, which had no way to turn a step's project-relative payload into a
 * path a pane could be pointed at. Standing on a translation therefore showed the
 * pages the translation was made FROM — a German book for somebody who had just
 * clicked the row labelled *Translated (Hungarian)* — with a sentence underneath
 * admitting it. A sentence is not a document. The resolution now exists
 * (`documentAtPosition`, electron/projects.ts) and the table says the thing that
 * is actually true of a row instead.
 *
 * ── And it used to be called `SHOWS_ITS_PAYLOAD`, which stopped being true ──
 *
 * The import still shows its payload: the untouched original is a document, and
 * standing on that row means looking at it. A TRANSLATION NO LONGER DOES. What a
 * translate step retains is its records file (`translationRecordsOf`) — per-block
 * answers, in the same layer and the same shape as a reading's bank — and nobody
 * reads a `.jsonl`. What it SHOWS is the book cast from those records, which is a
 * rendering (`translationCastFile`), resolved the way every other rendering in this
 * app is: by asking the project what it holds.
 *
 * So the question the table answers is the one that did not change: IS THIS ROW A
 * BOOK OF ITS OWN, or is it another state of the project's one flowing book? Both
 * of its `true`s are books of their own — the untouched original and the
 * translation — and everything downstream wanted that question rather than the
 * payload one. `documentAtPosition` asks it to decide which document to resolve;
 * `positionPicture` asks it to decide whether the ROW belongs in the key, which is
 * what makes clicking between two translations of one book repaint; and
 * `standForDocument` asks it while walking DOWN a chain, because a descendant that
 * is a book of its own must stop the walk rather than be offered as the newest step
 * of the reading it was made from.
 *
 * A READ AND A SAVE ARE NOT. A readings bank is per-page model answers and a
 * curation snapshot is a set of decisions about blocks; what those rows show is the
 * project's flowing book, in the state that row is about.
 *
 * IT IS A FACT ABOUT THE ROW AND NOT ABOUT THE CHAIN, exactly as `DISPLAYS_ITSELF`
 * is: "what kind of thing is this row" is answered by looking at it, where "what
 * state is in effect" is answered by walking. Writing it as `action === 'translate'`
 * at the call sites that ask would make the next change a search for every place
 * that guessed.
 */
export const A_BOOK_OF_ITS_OWN: Readonly<Record<StepAction, boolean>> = {
  import: true,
  /*
   * FALSE, AND IT IS THE ONE ENTRY IN THESE TABLES ANSWERING A QUESTION THIS
   * ACTION DOES NOT FIT. The table asks: is this row a book of its own, or
   * another state of the project's one flowing book? A capture is neither — it
   * is what exists BEFORE there is a book. `true` would send
   * `documentAtPosition` off to resolve a directory of photographs as a
   * document; `false` sends it to ask the project what it holds, and until a
   * mint lands the honest answer is nothing.
   *
   * P3's audit walks this against a real capture project and writes the verdict
   * into docs/CAPTURE.md, rather than leaving it resting on this comment.
   */
  capture: false,
  read: false,
  curate: false,
  translate: true,
  /*
   * A METADATA ROW'S PAYLOAD IS A PATCH, which is no more a thing a person reads
   * than a curation snapshot is. What it shows is what the row beneath it shows —
   * the book this project is working on, which is resolved by asking the project
   * what it holds. The document did not change identity because its title did.
   */
  metadata: false,
  /*
   * AN EDIT ROW'S PAYLOAD IS A LIST OF CHANGES, which is no more a thing a person
   * reads than a curation snapshot is. What it shows is the project's one flowing
   * book with those changes in it — the same book the read row shows, in the state
   * this row is about — so it is a `read`'s answer and not the import's.
   */
  edit: false,
};

/** Everything that decides the picture at the position, in one answer. */
export interface PositionView {
  /** The row being stood on, or null for a project with nothing recorded yet. */
  step: LedgerStep | null;
  /**
   * The reading whose bank the pages are drawn from, or null.
   *
   * `readingInEffect`, unchanged and unwrapped: it is the walk that finds the pass
   * over the pages this branch of the story is about, and a caller that composed
   * the bank path from the project key instead would be the exact lie that
   * function's header is about.
   */
  reading: LedgerStep | null;
  /** The frozen save drawn over them, or null when the answer is the live corrections. */
  curation: LedgerStep | null;
  /**
   * True when the document at this position is a BOOK OF ITS OWN — the untouched
   * original, the translation — rather than the project's one flowing book in the
   * state this row is about. See `A_BOOK_OF_ITS_OWN`.
   *
   * Main is the side that turns either answer into a path (`documentAtPosition`,
   * electron/projects.ts); what this decides is WHICH QUESTION it asks, and it is
   * asked here so that the renderer's change detection and main's resolution
   * cannot come to two opinions about it.
   */
  own: boolean;
  /**
   * True when what stands at this position is THE PROOF SHEET rather than a
   * document — the book file with this row's changes replayed over it.
   *
   * ── Why this is one answer and not a test at every door ────────────────────
   *
   * A read row and an edit row show the book (docs/RENDERER.md §6): the read
   * because the cast EPUB stopped being the flowing document the moment there was
   * a book file, the edit because its payload is a list of changes and what it is
   * ABOUT is the sheet. Both were spelled `action === 'read' || action === 'edit'`
   * at the call site, and there are two call sites — clicking a row, and opening
   * a row in a split — which had already drifted apart by one action. Two doors
   * onto one surface that disagree about who may come through is exactly the bug
   * that has no symptom until somebody uses the second one.
   *
   * AND AN IMPORTED EPUB'S ORIGIN ROW SHOWS IT TOO, which is the honest door this
   * wave owed. Such a project has no read step and never will — a bank models
   * pages and an EPUB has none, so its book is exploded straight out of the
   * container (§6's refinement, `book = f(epub)`) — and the import IS therefore
   * the row that book belongs to. Sending it to `showDocument` instead opens the
   * archived EPUB in the iframe reader, which is the surface this whole wave
   * exists to stop being the answer.
   */
  sheet: boolean;
  /**
   * The edit steps whose ops are replayed over the book here, oldest first.
   *
   * `editsInEffect`, unwrapped, and it is in the picture for the reason every
   * other field is: it decides what is on screen. Two rows can share a reading, a
   * curation and a translation and still be two different books — press Apply and
   * the pointer moves onto a row that differs from the one below it by nothing a
   * bank or an overlay knows about. Without this term `positionPicture` would call
   * those two rows the same picture and the sheet would go on showing the book as
   * it was before the changes were applied to it.
   */
  edits: LedgerStep[];
}

/**
 * The picture at the position — composed from the three selectors above and
 * deriving nothing of its own.
 *
 * That is deliberate to the point of being the whole design. `readingInEffect`
 * and `displayedCuration` are two DIFFERENT questions with two different walks
 * (see `DISPLAYS_ITSELF` for why folding them together would be a boolean where
 * the difference in meaning is), and this is the one place that holds both
 * answers at once because the pane needs both at once: which blocks, and which
 * corrections over them.
 */
export function positionView(ledger: ProjectLedger): PositionView {
  const step = positionOf(ledger);
  const reading = readingInEffect(ledger);
  return {
    step,
    reading,
    curation: displayedCuration(ledger),
    own: step !== null && A_BOOK_OF_ITS_OWN[step.action],
    /*
     * AND AT R6b IT IS EVERY ROW A BOOK CAN BE SEEN AT, which is the assumption
     * the whole plan was built on coming true (docs/RENDERER.md §0, A1: *"one
     * editing surface"*). A `curate` row and a `translate` row used to show a
     * per-step CAST — an EPUB written into `generated/` at the landing so a pane
     * had files to unpack — and those casts are gone with the reader that opened
     * them (§7). What replaced them is not another document: a save's decisions
     * are re-keyed and replayed like any other step's, and a translation's words
     * are already in the derived book file its landing wrote (§4). So both rows
     * are answered by the sheet, computed when somebody stands there rather than
     * frozen into a file beside the row.
     */
    sheet: step !== null && (
      step.action === 'read'
      || step.action === 'edit'
      || step.action === 'curate'
      || step.action === 'translate'
      || (step.action === 'import' && importedAsEpub(ledger))
    ),
    edits: editsInEffect(ledger),
  };
}

/**
 * Did this project arrive as a book — an EPUB rather than a scan?
 *
 * ── Read off the ORIGIN's own payload, which is the record of what happened ──
 *
 * The manifest's `archive.kind` says the same thing and is main's to read; this
 * module is shared, has no manifest and must not grow a second way to reach one.
 * What it has is the ledger, and the ledger's origin row is the import — the only
 * step whose parent is null (`originStep`) — whose payload IS the archived file
 * the project was made from. So the question is answered by the record of the act
 * rather than by a second opinion composed somewhere else, which is this module's
 * standing rule for every other question about a position.
 *
 * The extension and nothing else, because that is what the import wrote: main
 * decides `kind` by the same test when it copies the file into `archive/`
 * (`importDocument`, electron/projects.ts), so the two cannot come apart.
 */
export function importedAsEpub(ledger: ProjectLedger): boolean {
  const origin = ledger.steps.find((step) => step.parent === null);
  return origin !== undefined && origin.payload.toLowerCase().endsWith('.epub');
}

/**
 * THE PICTURE AS ONE STRING, so a surface can tell "the user moved" from "the
 * user moved somewhere that looks the same".
 *
 * ── The pointless reload this exists to prevent ─────────────────────────────
 *
 * The obvious key is the step id, and the step id is wrong in both directions.
 * Two rows can share a reading — a save and the reading it was made from, a
 * translation and the reading under it — and reloading a bank because somebody
 * clicked between them would put a spawn of the engine and a re-measure of five
 * hundred pages behind the one gesture in this app that is meant to be free. And
 * one row can be stood on twice with different pictures under it, because a
 * re-read swaps a bank in beneath a position that never moved.
 *
 * So the key is what actually decides what is on screen: which bank, which
 * corrections over it, and — for a row that shows its own payload — which row,
 * because two translations of one book share a reading and a curation and are
 * still two different documents to be standing on. That last term is also what
 * makes a move between the import and a translation re-ask main which file belongs
 * on screen: both rows show a payload of their own, neither changes the bank or
 * the corrections, and without the row in the key the pane would sit on whichever
 * of the two it happened to be showing.
 *
 * NUL-JOINED for `identityOf`'s reason: it is the one byte that cannot appear in
 * a uuid, so no pair of ids can run together into a third spelling that collides
 * with an honest one.
 */
export function positionPicture(view: PositionView): string {
  return [
    view.reading?.id ?? '',
    view.curation?.id ?? '',
    view.own ? view.step?.id ?? '' : '',
    /*
     * AND THE CHAIN OF EDITS, which is the fourth thing the ledger knows that
     * decides what is on screen and the only one whose value is a LIST. A book
     * five Applies deep is a different book from the same book four Applies deep,
     * and stepping between those two rows has to repaint the sheet even though
     * they share a bank, a curation and a translation. The IDS rather than a
     * count, because stepping between two sibling edit branches off one reading
     * changes neither the bank nor the number.
     */
    view.edits.map((step) => step.id).join(','),
  ].join('\u0000');
}

// ─────────────────────────────────────────────────────────────────────────────
// Which pass over the pages a set of answers is about
//
// The generation is the id a translation's records carry, so a set of answers can
// say which reading of the pages it is about. It is a uuid, and this module has
// no randomness (see the header), so the one function here is handed one and says
// whether it was spent — the same shape `LandedRun.id` already uses for a step id.
//
// IT WAS A FAMILY OF THREE. `generationInEffect` reconciled the id an OVERLAY was
// bound to against the bank's completion marker, and archived the pair aside when
// they disagreed; that whole reconciliation is deleted with the overlay system
// (docs/RENDERER.md §7). What survives is the landing, because a records file
// still wants to name its reading.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The generation a READING THAT HAS JUST FINISHED lands with.
 *
 * ── Every landing mints, with one exception, and the exception is the point ──
 *
 * A reading that lands is a bank that is now on disk and was not before: a first
 * read, a re-read swapped in over the old one, or a branch beside it. In all
 * three the blocks are the model's answers from THIS pass and the `(page, order)`
 * numbers an older overlay carries mean different blocks, so the id moves and the
 * archive-the-pair machinery hands that overlay off. Minting is the rule.
 *
 * THE EXCEPTION IS A FIRST READ THAT SOMEBODY WATCHED. Open the block editor
 * while the first OCR is running and the app mints a first-touch generation
 * against the pages read so far, and a person can start correcting them; the run
 * then finishes by appending the remaining pages to the SAME bank. Nothing those
 * corrections name has moved. Minting there would archive their work aside as the
 * reward for having started early, for a run that renumbered nothing.
 *
 * So a landing adopts when all of this holds: this is the project's first read
 * step (there is no other for the id to be wrong about), the record was made by a
 * first touch and never by a landing (`readAt === 0`), and the marker it was
 * minted against is either absent — nothing had completed, so the run in progress
 * is the one that made those pages — or is the very marker this landing sees,
 * meaning the bank finished before and has not been read since.
 *
 * A RECORD WITH A DIFFERENT MARKER IS THE CASE THIS RULE EXISTS TO REFUSE. A bank
 * read from a terminal, corrected in the app, then read again from the OCR dialog
 * lands as this project's first read step with `readAt === 0` — every condition
 * of the old rule met — and the bank underneath it is a completely new pass. The
 * stamp is what tells those two apart.
 */
export function generationForLanding(
  ledger: ProjectLedger,
  reading: ProjectReading | null,
  /** The marker this run wrote for its own bank, epoch ms, or null for none. */
  markerAt: number | null,
  minted: string,
): string {
  if (ledger.steps.some((step) => step.action === 'read')) return minted;
  if (reading === null || reading.readAt !== 0) return minted;
  if (reading.completedAt === undefined || reading.completedAt === markerAt) return reading.generation;
  return minted;
}

/**
 * The list, in creation order, with the one annotation that admits to the tree.
 *
 * `from` is set only when a row's parent is NOT the row immediately above it.
 * That is the entire concession: no rails, no indentation, no graph. A project
 * worked straight through draws as a plain list of what happened, and the one
 * book where somebody stepped back and branched shows a quiet "from Read" on the
 * row where it happened — which is the only row where the flat list would
 * otherwise be misleading about what was made from what.
 *
 * THE ARRAY'S ORDER IS TAKEN AS THE CHRONOLOGY rather than re-sorted by
 * `createdAt`, and that is deliberate. `parseLedger` refuses a file whose rows
 * run backwards and `appendStep` cannot produce one, so the order is an
 * invariant — and re-sorting here would mean two rows stamped in the same
 * millisecond could swap places between one repaint and the next, moving a
 * "from …" annotation onto a different row for no reason a person could see.
 */
export function chronological(ledger: ProjectLedger): StepRow[] {
  return ledger.steps.map((step, index) => {
    const above = index === 0 ? null : ledger.steps[index - 1]!;
    if (step.parent === null) return { step, from: null };
    if (above !== null && above.id === step.parent) return { step, from: null };
    const parent = ledger.steps.find((candidate) => candidate.id === step.parent);
    return { step, from: parent?.label ?? null };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Building one for a project that predates all of this
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A ledger for a manifest that has none, out of what the old catalogue recorded.
 *
 * ── What can honestly be reconstructed, and what cannot ─────────────────────
 *
 * Modelled on `migrateToSteps` in shared/steps.ts, including its rule: a
 * migration says what the catalogue said and never invents what it did not. The
 * old catalogue recorded an import, the fact and size of a completed reading, and
 * a chain of files per type. It did not record which reading a translation was
 * made from, or what language it was into — that survives only inside a filename,
 * and reading a fact out of a filename is the basename matching this codebase
 * has already paid for twice.
 *
 * So three things come out, and nothing else:
 *
 *   THE ORIGIN, from `archive`, or from the first chain's origin for a project
 *   adopted out of the old flat workspace, which has outputs and no import.
 *
 *   THE READING, when there is evidence of one. `manifest.reading` is the direct
 *   evidence; a v1 catalogue predates that field entirely, and its evidence is
 *   that the engine MADE something — every `expensive` step in a chain was cast,
 *   reprinted, written out or translated from a bank, and none of those can
 *   exist without one. A project imported and never converted gets no reading
 *   step, and neither does one started from an EPUB, which has no pages to read.
 *
 *   THE TRANSLATIONS, one per `translate` step in the chains, oldest first,
 *   parented to the reading where there is one. Their payload is the EPUB that
 *   was retained, because that IS what was retained — the per-block translation
 *   bank is a later invention and no old project has one.
 *
 * Renderings do NOT become steps, which is the substantive judgement here rather
 * than a detail of shape. A cast EPUB, a reprinted PDF and a text file are three
 * renderings of one bank, free to make again; minting a step for each would put
 * three filenames where one action belongs and would offer the user a delete
 * button for something that costs nothing.
 *
 * ── Determinism, and why it is a requirement rather than a nicety ───────────
 *
 * READING A MANIFEST TWICE MUST PRODUCE THE SAME LEDGER, byte for byte. This
 * runs on every read of an un-migrated project — `readManifest` migrates in
 * memory and writes back only when something else edits the file — so a ledger
 * built from a uuid generator or from `Date.now()` would give a project a
 * different history on every open, and the ids in it are what the pointer, the
 * parent chain and the queue's captured parent all point at. A pointer written
 * on Tuesday would name a step that no longer exists on Wednesday.
 *
 * So the ids are ordinal — `m0`, `m1`, … in the order the steps are built — and
 * derived from nothing but the manifest's own contents and order. A hash of the
 * payload path was the obvious alternative and is worse: two chain rows are
 * allowed to name one file, and two steps with one id is a ledger that refuses
 * itself. The `m` says out loud that these were reconstructed rather than
 * recorded.
 *
 * The times come from the catalogue too — `createdAt` for the import, `readAt`
 * for the reading, `appliedAt` for a translation — clamped so the list never
 * runs backwards, because a v1 catalogue's `madeAt` values were written by
 * whatever the clock said at the time and one of them being earlier than the
 * import is a thing that happens.
 */
export function migrateLedger(manifest: ProjectManifest): ProjectLedger {
  const chains = manifest.documents ?? [];
  const origin = originPayload(manifest);
  if (origin === null) return emptyLedger();

  const steps: LedgerStep[] = [];
  let at = 0;
  let clock = Math.max(0, Math.trunc(manifest.createdAt));
  const mint = (
    parent: string | null,
    action: StepAction,
    payload: string,
    createdAt: number,
    label: string,
    params?: LedgerParams,
  ): LedgerStep => {
    clock = Math.max(clock, Math.max(0, Math.trunc(createdAt)));
    const step: LedgerStep = {
      id: `m${at}`,
      parent,
      action,
      payload,
      retention: RETENTION_OF[action],
      createdAt: clock,
      label,
    };
    // An empty bag is not written. A migrated reading that recorded neither a
    // generation nor a page count says nothing about itself, and `"params": {}`
    // in every one of those manifests is a field that looks like a record of
    // something. Absent and empty mean the same to every reader of a step.
    if (params !== undefined && Object.keys(params).length > 0) step.params = params;
    at += 1;
    steps.push(step);
    return step;
  };

  const imported = mint(null, 'import', origin.payload, manifest.createdAt, origin.label);

  let readFrom = imported;
  const reading = readingParams(manifest, chains);
  if (reading !== null) {
    readFrom = mint(
      imported.id,
      'read',
      `readings/${manifest.key}.jsonl`,
      manifest.reading?.readAt ?? manifest.createdAt,
      labelFor('read', reading),
      reading,
    );
  }

  // Oldest first, so the list reads in the order it happened. A v1 catalogue's
  // order was insertion order, which a rotation could disturb — the same reason
  // `migrateToSteps` sorts rather than trusting it.
  const translations = chains
    .flatMap((record) => record.steps)
    .filter((step) => step.kind === 'translate')
    .sort((a, b) => a.appliedAt - b.appliedAt);
  for (const translation of translations) {
    // NO `language` PARAM. It is legible only in the filename — `… (en).epub` —
    // and deriving a fact about a book from the characters in its name is what
    // this codebase's oldest house rule exists to forbid. The label the old
    // catalogue wrote is already in the app's voice, so it is kept as it stands.
    mint(readFrom.id, 'translate', translation.file, translation.appliedAt, translation.label);
  }

  // NO POINTER, which means the newest step. That is where somebody opening a
  // migrated project should land: at the last thing that happened to their book.
  return { steps };
}

/** The import a ledger hangs off, and what the old catalogue called it. */
function originPayload(manifest: ProjectManifest): { payload: string; label: string } | null {
  const chains = manifest.documents ?? [];
  const firstOf = (kind: ProjectStep['kind']): ProjectStep | undefined => chains
    .flatMap((record) => record.steps)
    .find((step) => step.kind === kind);

  // `!= null` for `readingParams`'s reason, two functions down: a manifest
  // assembled by hand rather than by `readManifest` can leave a field off
  // entirely, and a test written against `null` walks into the property access it
  // was meant to guard.
  if (manifest.archive != null) {
    const named = firstOf('origin');
    return {
      payload: `archive/${manifest.archive.file}`,
      // The old catalogue's own words where it recorded them — "The scan you
      // imported", "The book you imported" — because they are already in the
      // app's voice and already tell a scan from a book.
      label: named?.label ?? labelFor('import'),
    };
  }
  // A project adopted from the flat workspace: outputs and no import. Its first
  // origin step is the closest thing it has to one, which is exactly the call
  // `migrateToSteps` makes for the same projects.
  const adopted = firstOf('origin');
  return adopted === undefined ? null : { payload: adopted.file, label: adopted.label };
}

/**
 * What is known about this project's reading, or null when nothing says there was
 * one.
 *
 * The generation and the page count are both allowed to be missing, and a v1
 * project's are. Writing `generation: ''` rather than omitting it would be this
 * app claiming to know which pass the bank came from, which is the one claim the
 * generation exists to make honestly — and `overlayFate` already prints an empty
 * generation as "unrecorded", so the state is one this app has met before.
 *
 * NO `skipPages` AND NO `language`, ever, and their absence is what makes a
 * migrated project's identity deterministic rather than merely unknown. Nothing
 * in an old catalogue recorded which pages a reading was told to leave out; the
 * only place that question survives is the shape of the bank itself, and
 * inferring "3,17,19-24" from gaps in a file is exactly the sort of reconstruction
 * this migration refuses to do. So a migrated reading asks the plain question —
 * the whole book, no language declared — which means a re-read that also asks the
 * plain question REPLACES it, and one that skips pages branches beside it. That is
 * the right answer in both directions and it is the same answer on every read of
 * the file.
 *
 * `!= null` RATHER THAN `!== null`: this took a manifest whose `reading` was
 * undefined — a shape the type does not admit and `readManifest` never produces,
 * because it always writes the field — and walked straight into reading
 * `.generation` off it. Unreachable today is not a reason to be wrong; the next
 * caller assembling a manifest by hand is the one who would find out.
 */
function readingParams(
  manifest: ProjectManifest,
  chains: readonly { steps: ProjectStep[] }[],
): LedgerParams | null {
  if (manifest.reading != null) {
    const params: LedgerParams = {};
    if (manifest.reading.generation.length > 0) params.generation = manifest.reading.generation;
    if (manifest.reading.pages > 0) params.pages = manifest.reading.pages;
    return params;
  }
  const madeByTheEngine = chains
    .flatMap((record) => record.steps)
    .some((step) => step.retention === 'expensive');
  return madeByTheEngine ? {} : null;
}
