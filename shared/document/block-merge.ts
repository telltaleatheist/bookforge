/**
 * When several blocks are one block, and the sentence for when they are not.
 *
 * Merge is the "the system thinks this is two blocks and it isn't" correction.
 * It joins their text in reading order into the earliest of them, so the only
 * selections it can honestly serve are ones the reader would have read straight
 * through: two or more, on one page, consecutive in the book's reading order.
 * Anything else produces a block whose text is not what any reader would have
 * met, and it does so looking exactly like a successful merge.
 *
 * The rule lives here — platform-neutral, no framework — because it is enforced
 * in three places that must say the same thing: the service that performs the
 * merge, the Merge button that offers it, and the block menu that offers it
 * again. One function, so a refusal and a greyed-out button are the same
 * sentence rather than two descriptions of the same rule.
 */

/** The minimum a block has to say about itself for a merge to be judged. */
export interface MergeCandidate {
  readonly id: string;
  readonly page: number;
  /** The block's place in the book's reading order, as its annotation states it. */
  readonly seq?: number;
}

/**
 * Why these blocks cannot be merged, or null when they can.
 *
 * Order matters: each check assumes the ones before it passed, so the sentence
 * names the first thing actually wrong rather than a consequence of it.
 */
export function mergeRefusal(blocks: readonly MergeCandidate[]): string | null {
  const unique = new Map<string, MergeCandidate>();
  for (const b of blocks) unique.set(b.id, b);
  const members = [...unique.values()];

  if (members.length < 2) {
    return 'Merging needs two blocks or more; one block is already one block.';
  }

  for (const b of members) {
    if (b.seq === undefined) {
      return `Block ${b.id} has no place in the book's reading order, so it did not come from this `
        + "book's working document. Reload the book before merging.";
    }
  }

  const ordered = members.slice().sort((a, b) => a.seq! - b.seq!);
  const lead = ordered[0];
  const stray = ordered.find(m => m.page !== lead.page);
  if (stray) {
    return `These blocks are on different pages (page ${lead.page + 1} and page ${stray.page + 1}). `
      + 'One block is one box on one page, so blocks that span a page break cannot be merged.';
  }

  for (let i = 1; i < ordered.length; i++) {
    const gap = ordered[i].seq! - ordered[i - 1].seq! - 1;
    if (gap > 0) {
      return `These blocks are not next to each other: ${gap} ${gap === 1 ? 'block sits' : 'blocks sit'} `
        + `between ${ordered[i - 1].id} and ${ordered[i].id} in the book's reading order. Merging joins `
        + 'what would have been read one after the other, so select what is between them too, or leave '
        + 'them out.';
    }
  }

  return null;
}

/** True when this selection is one the merge would accept. */
export function canMerge(blocks: readonly MergeCandidate[]): boolean {
  return mergeRefusal(blocks) === null;
}
