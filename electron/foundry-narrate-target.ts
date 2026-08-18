/**
 * WHICH EXPORTED EPUB A NARRATION READS — the choice, on its own.
 *
 * `foundryNarrationTarget` in main.ts does two separable things: it finds the
 * book a Foundry project belongs to and reads its version list (claims, the
 * manifest, the disk), and then it CHOOSES which of that project's exported
 * EPUBs the press meant. Only the second half is a decision about values, and
 * it is the half that can be wrong in a way nobody notices — so it lives here,
 * where a keeper can reach every branch from a hand-built array instead of from
 * two applications and a library with two exports in it.
 *
 * Nothing in this file imports anything. That is the point.
 *
 * ── THE RULE, WHICH IS OWEN'S IDENTITY LAW ──────────────────────────────────
 *
 * A press that NAMES A FILE names the answer. Since foundry e8396b4, an export
 * row's press — and the rail's TTS button — sends `export:<project-relative
 * file>` instead of a ledger step id (`exportNodeId` in their
 * shared/host-ops.ts; `export:` is a reserved prefix on the socket). The user
 * pressed the button ON that document, so second-guessing it with a uniqueness
 * rule would refuse a press that carried no ambiguity at all.
 *
 * A STEP-SHAPED id resolves by uniqueness instead, because it carried no file:
 * two EPUB exports under two names mean the press did not say which, and
 * picking one because of which step it came from would be this side inventing a
 * linkage that does not exist.
 *
 * ── WHY THE ORDER OF THE REFUSALS IS LOAD-BEARING ───────────────────────────
 *
 * Zero exports is answered BEFORE the named file is looked at. A project with
 * nothing exported cannot have been pressed on an export row in this library's
 * present state, so "the press named X and there is no X" would be a true
 * sentence that sends the user hunting for a missing file when what they
 * actually need is to export the book once. The export-first sentence is the
 * useful one, and it wins.
 */

/** One exported EPUB, reduced to what the choice actually needs. */
export interface NarrationExport {
  /** The manifest variant id — what the caller turns back into a path. */
  readonly id: string;
  /**
   * `FoundryVariantSource.fileName`: the basename the landing was filed under,
   * which is what an `export:` id's project-relative path is matched against.
   */
  readonly fileName: string;
}

/**
 * The project-relative file an `export:`-shaped node id names, or null.
 *
 * Our own minted ids (`bf-node:job:step`) cannot collide with the prefix, and
 * engine step ids carry no colon at all. A bare `export:` with nothing after it
 * names no file, so it is treated as step-shaped rather than as a file called
 * the empty string.
 */
export function exportFileOfNodeId(nodeId: string): string | null {
  if (!nodeId.startsWith('export:')) return null;
  const file = nodeId.slice('export:'.length);
  return file === '' ? null : file;
}

/**
 * The variant id this press means, or a refusal saying why there is not one.
 *
 * `projectId` appears only in the refusals — it is the folder name the user
 * would go looking at — and never in the choosing.
 */
export function chooseNarrationExport(
  nodeId: string,
  exported: readonly NarrationExport[],
  projectId: string,
): string {
  if (exported.length === 0) {
    /*
     * NO AUTO-EXPORT, and that is a decision rather than an omission. Exporting
     * is Foundry's act with Foundry's dialog choices — which format, from which
     * step, under what name — and a host that ran one on the user's behalf would
     * be guessing every one of them. The user is one button away from making the
     * real choice.
     */
    throw new Error(
      `${projectId} has no exported EPUB from this project, and narration reads a book file. `
      + 'Export the book from Foundry first (it lands on the version list as a version), then '
      + 'press Narrate again.');
  }

  /*
   * THE PRESS NAMED A FILE — resolve that file and no other. The id carries the
   * catalogue's project-relative path; `fileName` records the basename every
   * landing was filed under, so the basename is the join.
   */
  const named = exportFileOfNodeId(nodeId);
  if (named !== null) {
    const base = named.split('/').pop()!;
    const variant = exported.find((v) => v.fileName === base);
    if (variant === undefined) {
      throw new Error(
        `The press named "${named}", but ${projectId}'s version list has no exported EPUB filed `
        + `under that name — it has ${exported.map((v) => v.fileName).join(', ')}. `
        + 'Export the book from Foundry again, then press Narrate on the new row.');
    }
    return variant.id;
  }

  if (exported.length > 1) {
    throw new Error(
      `This Foundry project has exported ${exported.length} EPUBs — `
      + `${exported.map((v) => v.fileName).join(', ')} — and this press does not `
      + 'say which one it is. Press Narrate on the export row itself, or start the narration '
      + `from the version you want on ${projectId}'s versions page.`);
  }

  return exported[0]!.id;
}
