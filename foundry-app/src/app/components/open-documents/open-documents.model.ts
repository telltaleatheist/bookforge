/**
 * open-documents.model — the rows, lanes, groups and acts the library rail draws.
 */
import { exportNodeId } from '@owen/foundry-core/shared/host-ops';
import type { HostOperationState } from '@owen/foundry-core/shared/host-ops';
import type { HostNode, HostNodeProgress, Job, LedgerStep, NodeOutput } from '@owen/foundry-core/shared/types';
import { LedgerService } from '../../core/ledger.service';
import { type Tab } from '../../core/documents.service';
import { drawLineage, titleForStep } from './open-documents.words';

/** What a right-click can offer, across the four kinds of row that have one. */
export type MenuAction = 'reveal' | 'save-copy' | 'view' | 'close' | 'delete' | 'close-project' | 'discard';

/**
 * ONE ACT OFFERED IN A CARD'S FOOTER — ours or the host's, drawn identically and
 * dispatched differently.
 *
 * `host` IS THE DISCRIMINANT and it is a string rather than a boolean because it
 * is also the thing `run` needs: null means one of Foundry's own three, in which
 * case `id` names which dialog to open; anything else is the host's operation id,
 * which is exactly what `host-ops:invoke` takes.
 */
export interface Act {
  /** Unique in the footer. Foundry's are `translate`/`simplify`/`export`. */
  id: string;
  label: string;
  /** A symbol in the sheet at the top of the template. */
  icon: string;
  /** Drawn in the host's amber rather than in the accent. */
  audio: boolean;
  /** The host operation to invoke, or null for one of this app's own acts. */
  host: string | null;
  /**
   * True when the host declared a `form` for it, so pressing opens Foundry's own
   * dialog instead of running immediately (`HostOperationOffer.form`). Always
   * false for this app's own three, which have dialogs of their own.
   */
  form: boolean;
  /** The hover sentence — the only place a footer button explains itself. */
  hint: string;
  /**
   * TRUE WHEN THIS TILE ACTS ON A ROW THAT HAS NOT LANDED — dimmed, and still
   * pressable.
   *
   * ── Owen's ruling is that both halves are true at once ────────────────────
   *
   * *"the export epub tile is grayed out until ai cleanup finishes"* AND *"i click
   * the grayed out row and hit the export epub tile."* A tile that were merely
   * disabled would satisfy the first sentence and make the second impossible, and
   * this panel's standing rule is the opposite of a disabled button anyway: *"a
   * button whose only possible outcome is a refusal is not drawn"* (shared/stages.ts).
   * The press here has a possible outcome — the export is planned, queued and made
   * the moment the cleanup lands — so the tile is drawn, is live, and says by being
   * dim that what it starts will not start now.
   */
  deferred: boolean;
  /** The host says this act is already done at this node (`HostOperationState.done`). */
  done?: boolean;
}

export const NO_ACTS: readonly Act[] = [];

/** One ancestor's lane, in the row's own drawn lineage. See `drawLineage`. */
export interface Lane {
  /** Whether that ancestor still has something below this row to reach. */
  line: boolean;
  /** Dashed when what it reaches down to has not happened yet. */
  dashed: boolean;
  /** True in the LAST lane of the first card of an indented run. */
  elbow: boolean;
}

/**
 * One drawn card of the library.
 *
 * FIVE KINDS, ONE SHAPE. A `root` and a `step` are POSITIONS — clicking one
 * moves where the book stands — and carry a `step`; an `export` and a `document`
 * are FILES and carry a tab when something has opened them; a `host` is a job in
 * somebody else's queue and carries a `node`. The template draws them all and
 * the gestures fork on `kind`, which is the one fact that decides everything
 * else about a card.
 */
export interface Row {
  /** Unique in the list: a tab id, or the book's key and what the row names. */
  key: string;
  kind: RowKind;
  /** The open tab, for the rows that are files. Always null on a position. */
  tab: Tab | null;
  /** A file for the rows that are files; the book's own directory for a position. */
  path: string;
  /**
   * The card's first line — a SENTENCE about what happened, derived from the
   * action and its params, never `LedgerStep.label` (see `titleForStep`).
   */
  title: string;
  /**
   * The parent's title, for the lineage line: "from **Applied changes**". Null
   * where there is no honest parent to name — the import, an export, a loose
   * file — and those say `said` instead.
   */
  from: string | null;
  /** One extra fact in front of the lineage: "41 edits", "312 pages". */
  fact: string | null;
  /** What this IS, for a card with no lineage to claim. */
  said: string | null;
  /** The right-hand slot: a date, or the host's own word about where it is up to. */
  state: string | null;
  /** A symbol id from the sheet at the top of the template. */
  icon: string;
  /** Which tint the icon square wears: this app's accent, the host's amber, or neither. */
  tint: 'plain' | 'text' | 'audio';
  /** Which state the dot draws. See the dot's styles. */
  dot: DotState;
  /** A running host node's live counting, or null. */
  progress: HostNodeProgress | null;
  /** A failed host node's sentence, drawn on a line of its own. */
  why: string | null;
  tooltip: string;
  /** How far in the tree. 0 for a root and for a loose file. */
  depth: number;
  /** The book this row belongs to. Null for a loose file, and only for that. */
  dir: string | null;
  /** The step a root or a step card names, when the history has arrived. */
  step: LedgerStep | null;
  /**
   * THE STEP AN EXPORT WAS MADE FROM — its provenance, and not its position.
   *
   * ── Why it is not `step` above ──────────────────────────────────────────────
   *
   * `step` is the row's OWN position: a thing you can stand on, delete, and act
   * from, and every gesture in this panel that reads it means exactly that. An
   * export has no position — it is terminal, *"it wont go into the working files
   * as a step because it isnt the base for new steps"* — but it does have a
   * PROVENANCE, which is the row of the ledger whose state it replayed. Two
   * different facts; putting them in one field would make a right-click on an
   * export offer to delete the step that produced it.
   *
   * NULL FOR EVERY EXPORT WRITTEN BEFORE `ProjectFinal.stepId` EXISTED, which is
   * an unknown provenance rather than none — see `run` for what the invoke sends
   * in that case.
   */
  madeFrom: string | null;
  /**
   * WHAT A PRESS ON THIS ROW NAMES ITSELF AS, when the row is a thing a host
   * act can be ordered from and is not a ledger step.
   *
   * Today that is export rows alone (`exportNodeId`). A step names itself by its
   * own id and a host node by the host's, both of which `nodeIdFor` reads
   * directly off the row — this field exists for the one kind of row whose
   * identity is a catalogue file rather than a record with an id.
   */
  nodeId: string | null;
  /** The host's own row, for `kind === 'host'`. Null everywhere else. */
  node: HostNode | null;
  /**
   * WHAT CAN BE MADE FROM HERE — the whole gate on the "from here" footer.
   * Null means nothing can: a terminal file, a loose one, or a position with no
   * book behind it yet.
   */
  produces: NodeOutput | null;
  /** True on the one card the book is standing on. */
  current: boolean;
  /**
   * True on the one step the BOOK ON THE SHELF was made from.
   *
   * NOT `current`, which is one card away in this same interface and means
   * something else entirely: `current` is where the PERSON is standing, this is
   * which mint Home opens. They are usually the same row and they come apart
   * exactly when it matters -- after a second mint, or after deleting one --
   * which is the whole reason this exists. Two things sharing a name is the
   * defect this feature has paid for four times; two things with different
   * names, next to each other, is the cheap version of not paying again.
   */
  onTheShelf: boolean;
  /** True for a step made from something that has been replaced since. */
  stale: boolean;
  /** True for a node that has not happened yet: dashed line, hollow dot. */
  planned: boolean;
  /**
   * THE QUEUE ROW THAT IS GOING TO LAND THIS CARD, for a promise — null on every
   * card that is a record of something that happened.
   *
   * ── Why the row and not just `planned` ─────────────────────────────────────
   *
   * `planned` is a DRAWING fact and has been since the host's queued nodes needed a
   * dashed line; three surfaces need more than that. Standing on a promise names
   * its step to `LedgerService.standOnPromise`, which needs the id the row will
   * mint. The footer's tiles say what they are waiting for. And `stand` has to know
   * not to send `ledger:go`, which main refuses for a step that does not exist —
   * correctly, because the pointer names a row of a file.
   *
   * A HOST NODE IS NOT ONE OF THESE. It carries `planned` too and its work belongs
   * to somebody else's queue entirely; what it has instead is `node`, which is the
   * host's own record. Two fields because they are two different queues, and a card
   * that could be either would be a card whose ✕, whose tiles and whose selection
   * mean two things.
   */
  promise: Job | null;
  /** Null when the card can never have children; otherwise whether it is open. */
  expanded: boolean | null;
  /** File rows only: false for a missing file and for `.txt`. */
  openable?: boolean;
  /** File rows only: whether the tab it opens wears the unsaved dot. */
  managed?: boolean;
  /**
   * True while this is the document IN THE VIEWER.
   *
   * It had a `column` beside it — 1…5, counted left to right, null when the
   * document was in none — and the two together were how the panel said "on
   * screen somewhere" and "on screen where a chord will land". One viewer makes
   * them one fact (docs/PLAN.md §4, unit 8b).
   */
  focused: boolean;
  // ── The drawn lineage, filled in by `drawLineage` once the group is whole ──
  /** One per ancestor level, outermost first. */
  lanes: readonly Lane[];
  /** Whether this card's own lane comes down from above into its dot. */
  up: boolean;
  /** Whether it continues below — to a sibling, or into a child's elbow. */
  down: boolean;
  /** Dashed when the thing that segment reaches has not happened yet. */
  downDashed: boolean;
}

export type RowKind = 'root' | 'step' | 'export' | 'document' | 'host';

export type DotState = 'source' | 'done' | 'running' | 'queued' | 'failed' | 'file';

/**
 * The fields every row has and most rows do not set.
 *
 * ONE DEFAULT AND NOT SIX LITERALS: a row is built in six places here, and
 * without this each of them would have to remember to say `stale: false` — which
 * they would, until somebody added a field, and then exactly one of them would
 * be missing it and exactly one kind of row would draw wrong.
 *
 * THE LINEAGE DEFAULTS TO NOTHING DRAWN, which is what the loose list wants: it
 * never goes through `drawLineage`, so a file opened from somewhere else gets a
 * card with a plain dot and no thread, and no relationship is asserted between
 * two of them.
 */
export const blank = {
  tab: null,
  step: null,
  node: null,
  from: null,
  fact: null,
  said: null,
  state: null,
  icon: 'ft-page',
  tint: 'plain',
  dot: 'file',
  progress: null,
  why: null,
  produces: null,
  madeFrom: null,
  nodeId: null,
  depth: 0,
  dir: null,
  current: false,
  onTheShelf: false,
  stale: false,
  planned: false,
  promise: null,
  expanded: null,
  focused: false,
  lanes: [],
  up: false,
  down: false,
  downDashed: false,
} satisfies Partial<Row>;

/** One book, and the tree drawn for it. */
export interface Group {
  key: string;
  title: string;
  dir: string;
  rows: Row[];
  /** Every tab open inside this book — what Close book closes. */
  tabIds: string[];
}

/**
 * Ours, so a row drag and a file drag can never be mistaken for each other.
 *
 * NOT EXPORTED ANY MORE, and the export is what it lost rather than the type.
 * The workspace read it on the other end of the same gesture — a row dragged out
 * of this list and dropped on a column — and there are no columns
 * (docs/PLAN.md §4, unit 8b), so both ends of every drag that carries this are
 * now in this file: the loose files' reorder, and nothing else. The string itself
 * is unchanged because App's file-drop veil is still written against the fact
 * that our drags do not carry `Files`, and a renamed type would be a second thing
 * to keep true for no gain.
 */
export const DOCUMENT_MIME = 'application/x-foundry-tab';
