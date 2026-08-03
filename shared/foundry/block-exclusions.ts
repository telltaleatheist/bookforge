/**
 * What the user deleted, said in an identity that survives a re-run.
 *
 * ── The bug this exists to make impossible ──────────────────────────────────
 *
 * A foundry block id is `p0007b012` — page index plus the block's POSITION on
 * that page, minted fresh by the blocks stage every time it runs
 * (`blockId(page, index)` in foundry's `src/commands.ts`). The ocr stage rewrites
 * line text, the blocks stage re-cuts and re-merges from that text, and the
 * indices shift: `p0007b012` after a re-run is a DIFFERENT block from
 * `p0007b012` before it.
 *
 * The editor's deletions were persisted under exactly those ids. So a queue
 * chain that re-ran ocr + blocks and then exported was handing `foundry export`
 * a list of ids that named nothing (loud — `foundry export` validates and
 * refused, Working Towards The Führer, Aug 3 2026) or, worse, named blocks the
 * user never deleted (silent, and it ships a book with the wrong pages missing).
 *
 * ── The identity that IS stable ─────────────────────────────────────────────
 *
 * SCAN LINE IDS. `p0007l0012` is minted once, by the scan stage, and:
 *
 *  - the ocr stage rewrites `text` and keeps the id (`ocr/lines.json` is one
 *    entry per scan line, same ids — verified on the failing run: 796 ids,
 *    identical sets);
 *  - the blocks stage carries them in `blocks[].lineIds` and every scan line
 *    lands in exactly one block (verified on the same run: 796 references, 796
 *    distinct, no line unclaimed and none claimed twice);
 *  - a stage that reads the scan (ocr, blocks, footnotes) does not rebuild it:
 *    `startFoundryRun` re-runs the stages it is GIVEN and reads the rest off
 *    disk, so a footnotes pass leaves the line ids exactly as they were.
 *
 * A line id is therefore stable exactly as long as the SCAN is, and the scan is
 * replaced whenever the run directory is recreated: the OCR-correction pass wipes
 * it — every time it is submitted, since a submitted pass never returns a cached
 * stage — and so does a changed page set. Both mint a new `run.json` `runId`, so
 * that id is carried alongside the line ids as their stamp — see
 * `FoundryDeletedLines`. A deletion record stamped with an older scan is refused
 * at export, which sends the user to the PDF editor, where the deletions
 * re-attach to the boxes on screen and are re-recorded against the new scan.
 *
 * ── What this module does ───────────────────────────────────────────────────
 *
 * `resolveExcludedBlockIds` turns the stable record back into the block ids the
 * exporter takes, against the blocks that are actually on disk right now. That
 * keeps foundry's interface as it is (it takes block ids and validates them,
 * which is right) and puts the re-derivation on the BookForge side, where the
 * deletions live.
 *
 * It never guesses. A line that is gone, or a block that holds deleted and
 * surviving lines at once, is a stop that names what could not be mapped.
 */

/** A block as the resolver needs it: an id, a page to name it by, and its lines. */
export interface FoundryBlockLines {
  readonly id: string;
  /** For error messages only. Whichever page numbering the caller thinks in. */
  readonly page: number;
  readonly lineIds: readonly string[];
}

/**
 * Deleted content, in the identity that survives an ocr/blocks re-run.
 *
 * `scanId` is the `runId` from the run directory's `run.json`. It is the scan's
 * identity because a run directory is recreated — new `runId` — whenever the
 * page set changes or the Tesseract pass is re-run with `redo`, which are the
 * only two things that re-mint line ids.
 */
export interface FoundryDeletedLines {
  readonly scanId: string;
  readonly lineIds: readonly string[];
}

export class FoundryExclusionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FoundryExclusionError';
  }
}

/**
 * `p0007b012` — a foundry block id, as opposed to every other kind of block id
 * a project can carry.
 *
 * A book that lived through the in-app OCR has deletions named `ocr_p0_eaz7rh_6`
 * or `merge_7105nt`, and a text-layer PDF's are 12 hex characters. None of those
 * can name a foundry block, and none of them can be mistaken for this shape.
 */
const FOUNDRY_BLOCK_ID = /^p\d{4}b\d{3}$/;

export function isFoundryBlockId(id: string): boolean {
  return FOUNDRY_BLOCK_ID.test(id);
}

function sample(ids: readonly string[], n = 8): string {
  return ids.slice(0, n).join(', ') + (ids.length > n ? ', …' : '');
}

/**
 * The line ids of the given blocks, in READING order — the blocks' own order,
 * not the caller's — so the record does not change when the same deletions
 * arrive as a differently-ordered set.
 *
 * Block ids the run does not know are REFUSED rather than skipped: this is the
 * write side of the record, and a deletion silently contributing no lines is a
 * deletion that stops happening at the next export.
 */
export function lineIdsOfBlocks(
  blocks: readonly FoundryBlockLines[],
  blockIds: Iterable<string>,
): string[] {
  const wanted = new Set(blockIds);
  const present = new Set(blocks.map(b => b.id));
  const unknown = [...wanted].filter(id => !present.has(id));
  if (unknown.length > 0) {
    throw new FoundryExclusionError(
      `${unknown.length} deleted block id(s) are not in this run's blocks: ${sample(unknown)}. `
      + 'Their lines cannot be recorded, so the deletion could not be carried across a re-run.',
    );
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    if (!wanted.has(block.id)) continue;
    for (const lineId of block.lineIds) {
      if (seen.has(lineId)) continue;
      seen.add(lineId);
      out.push(lineId);
    }
  }
  return out;
}

/**
 * The blocks of the CURRENT run that a recorded line set covers ENTIRELY.
 *
 * The same computation `resolveExcludedBlockIds` does, WITHOUT the stop — and
 * that difference is the whole point of it existing separately.
 *
 * A DELETION is a fact only the user holds: nothing on disk can re-derive it, so
 * a line that no longer maps has to stop the export by name rather than be
 * guessed at. An AUTO-DECISION is the opposite — the editor's one-title rule
 * (`applyFoundryTitleRule`) can look at the blocks in front of it and reach the
 * same verdict again from scratch. Its ledger of "already ruled on" exists only
 * so a ruling the USER REVERSED is not re-imposed; a ruling that cannot be
 * placed on this run's blocks is simply re-derived, which costs nothing and
 * cannot be wrong in a way nobody sees.
 *
 * So straddled blocks and missing lines are dropped here instead of thrown: a
 * unit the re-run cut through is a unit the rule gets to judge afresh.
 */
export function blockIdsCoveredByLines(
  blocks: readonly FoundryBlockLines[],
  lineIds: Iterable<string>,
): string[] {
  return planFoundryExclusions(blocks, lineIds).excluded;
}

export interface FoundryExclusionPlan {
  /** Blocks every one of whose lines was deleted. These are the exclusions. */
  readonly excluded: string[];
  /**
   * Blocks holding deleted lines AND kept ones, because the re-run moved a block
   * boundary through a deletion. Neither answer is right for these: excluding
   * one drops text nobody deleted, keeping it ships text somebody did.
   */
  readonly straddled: FoundryBlockLines[];
  /** Deleted lines that are in no block at all — a different scan of the book. */
  readonly missing: string[];
}

/**
 * Which blocks of the CURRENT blocks.json the deleted lines add up to, and what
 * could not be answered.
 *
 * Split from the throwing form because the two callers need different things
 * from the same computation: the exporter must refuse the whole book rather
 * than ship a wrong one, while the editor — where a person is looking at the
 * page — applies what resolved and says out loud what did not.
 */
export function planFoundryExclusions(
  blocks: readonly FoundryBlockLines[],
  deletedLineIds: Iterable<string>,
): FoundryExclusionPlan {
  const deleted = new Set(deletedLineIds);
  const owner = new Map<string, FoundryBlockLines>();
  for (const block of blocks) {
    for (const lineId of block.lineIds) {
      const already = owner.get(lineId);
      if (already) {
        throw new FoundryExclusionError(
          `line ${lineId} is claimed by both block ${already.id} (page ${already.page + 1}) and `
          + `block ${block.id} (page ${block.page + 1}). A run's blocks partition its scan lines, `
          + 'so this run directory is corrupt — re-run the OCR-correction pass.',
        );
      }
      owner.set(lineId, block);
    }
  }

  const excluded: string[] = [];
  const straddled: FoundryBlockLines[] = [];
  for (const block of blocks) {
    let hit = 0;
    for (const lineId of block.lineIds) if (deleted.has(lineId)) hit++;
    if (hit === 0) continue;
    if (hit === block.lineIds.length) excluded.push(block.id);
    else straddled.push(block);
  }

  return { excluded, straddled, missing: [...deleted].filter(id => !owner.has(id)) };
}

/**
 * The plan, or a stop naming what could not be mapped.
 *
 * A block is excluded when every one of its lines was deleted. Anything else
 * throws, because both remaining answers are wrong in a way nobody would see:
 * dropping a straddled block removes text the user never deleted, keeping it
 * ships text they did, and a missing line means these deletions were made
 * against a scan that is not the one on disk.
 */
export function resolveExcludedBlockIds(
  blocks: readonly FoundryBlockLines[],
  deletedLineIds: Iterable<string>,
): string[] {
  const plan = planFoundryExclusions(blocks, deletedLineIds);

  if (plan.missing.length > 0) {
    throw new FoundryExclusionError(
      `${plan.missing.length} deleted line(s) are not in this run's blocks: `
      + `${sample(plan.missing)}. The deletions were recorded against a different scan of this `
      + 'book, so they cannot say which blocks to drop. Open the book in the PDF editor and redo '
      + 'the deletions.',
    );
  }

  if (plan.straddled.length > 0) {
    const named = plan.straddled
      .slice(0, 5)
      .map(b => `${b.id} (page ${b.page + 1})`)
      .join(', ');
    throw new FoundryExclusionError(
      `${plan.straddled.length} block(s) hold both deleted and kept lines after this run re-cut `
      + `the page: ${named}${plan.straddled.length > 5 ? ', …' : ''}. Dropping such a block would `
      + 'remove text that was never deleted, and keeping it would ship text that was. Open the '
      + 'book in the PDF editor and redo the deletions on those blocks.',
    );
  }

  return plan.excluded;
}
