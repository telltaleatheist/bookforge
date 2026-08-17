/**
 * shared/host-ops — the whole vocabulary of the HOST-OPERATIONS SOCKET, in one
 * file, because both sides of the seam and both sides of the preload read it.
 *
 * ── What the socket is for ──────────────────────────────────────────────────
 *
 * Foundry makes the TEXT of a book: it reads pages, it takes edits, it
 * translates, it exports. BookForge makes AUDIO out of that text — a narration,
 * an enhancement pass, an assembled m4b — and the user ruled that those acts
 * belong on the provenance tree beside the acts that made the words, because
 * from a reader's side "translate this, then narrate the translation" is one
 * pipeline and not two applications (docs/BOOKFORGE-HANDOFF.md §8,
 * #bookforgenotes 2026-08-17).
 *
 * So the tree grows a socket rather than an audio feature. A host registers
 * OPERATIONS at `mountFoundry` and pushes NODES with `setHostNodes`; Foundry
 * draws both in the card grammar it draws its own steps in, and knows nothing
 * whatever about narration. Standalone, nobody registers anything, the socket
 * answers with two empty lists, and the tree is exactly the tree.
 *
 * ── THE LEDGER STAYS PURE, and that is the rule this file exists to keep ────
 *
 * A host node is a DISPLAY ROW. It is never written to `project.json`, it is
 * never a `LedgerStep`, nothing is ever made from it by this app, and it lives
 * only as long as the host keeps pushing it. The ledger is the record of what
 * happened to the TEXT, and an audiobook that BookForge made is not that — it is
 * BookForge's own record, kept in BookForge's own queue, shown here because this
 * is where the user is standing when they decide to make one.
 *
 * The failure this rule prevents is worth naming: a host node written into the
 * ledger would be a step whose payload lives in another application's data
 * directory, which the sweep would not find, the delete confirm could not cost,
 * and `parseLedger` would refuse the day BookForge stopped writing it.
 */
import type { HostOperationKind, NodeOutput } from './types';

/**
 * WHAT EACH KIND OF HOST OPERATION PRODUCES — the table that decides what may be
 * chained onto what.
 *
 * A `Record` over the union rather than a `switch` with a default, deliberately:
 * a fourth kind of audio work is a compile error here until somebody says what
 * it makes, which is the loud failure this codebase prefers to a silent 'audio'
 * that happens to be right today. The same reason `RETENTION_OF` is a table
 * (shared/ledger.ts).
 *
 * ALL THREE PRODUCE AUDIO TODAY and that is not a coincidence worth collapsing:
 * `appliesTo` is what gates the offers, so a narrate (which CONSUMES a book and
 * PRODUCES audio) is the row that makes the two columns of this arrangement
 * visible. Consumption is declared per operation; production is a fact about the
 * kind, because two hosts registering a `narrate` that produced different things
 * would be two hosts disagreeing about what the word means.
 */
export const PRODUCES_OF: Readonly<Record<HostOperationKind, NodeOutput>> = {
  narrate: 'audio',
  enhance: 'audio',
  assemble: 'audio',
};

/**
 * Which of a host's operations may be offered from a node that produces this.
 *
 * ONE FUNCTION SO THE TWO SURFACES CANNOT DISAGREE. The tree's "from here"
 * footer asks it to decide what to draw, and it is the same question a host
 * would ask before it enqueued — a text act like Translate is never offered on
 * an audio node, and Assemble is never offered on a book. Written here rather
 * than in the component because the component is not the place a policy about
 * somebody else's operations should live.
 */
export function offeredFrom(
  offers: readonly HostOperationOffer[],
  produces: NodeOutput,
): readonly HostOperationOffer[] {
  return offers.filter((offer) => offer.appliesTo === produces);
}

/**
 * ONE HOST OPERATION, as the RENDERER sees it — everything but the doing.
 *
 * The doing is `HostOperation.invoke` (electron/host.ts), which is a function in
 * the host's own main process and therefore cannot cross the preload. What
 * crosses is this: an id to name it by, words to draw, a kind that picks the
 * icon, and the one fact that decides where it may be offered. The renderer asks
 * main to run it BY ID (`host-ops:invoke`), which is also what keeps a renderer
 * from being able to call an arbitrary function in the host: the id has to be
 * one the host itself registered.
 */
export interface HostOperationOffer {
  /**
   * The host's own, unique among its operations. It is what `host-ops:invoke`
   * names, so a host that changes it between mounts has changed the operation.
   */
  id: string;
  /** What the button says: "Narrate", "Enhance", "Assemble". One or two words. */
  label: string;
  /**
   * WHICH ACT THIS IS, and therefore which icon and tint it wears. The tree
   * draws audio work in amber and text work in the accent, so this is the field
   * that makes an audio act legible as one at a glance.
   */
  kind: HostOperationKind;
  /**
   * WHAT A NODE MUST PRODUCE for this operation to be offered from it.
   *
   * A narration consumes the book's text, so it applies to `book`; an assemble
   * consumes the narrated audio, so it applies to `audio`. This is the whole of
   * the chaining rule — see `offeredFrom` — and it is declared by the host
   * rather than derived from `kind`, because a host that grew an operation
   * consuming audio and producing audio (an enhance) and one consuming text and
   * producing audio (a narrate) needs to say which is which.
   */
  appliesTo: NodeOutput;
}
