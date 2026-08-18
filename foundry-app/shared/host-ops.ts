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
import type { HostNodeState, HostOperationKind, NodeOutput } from './types';

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
 * WHETHER ANYTHING MAY BE CHAINED ONTO A NODE IN THIS STATE.
 *
 * ── The screenshot that produced this table ─────────────────────────────────
 *
 * *"Owen's screenshot of a FAILED narrate node: the card still offers 'FROM
 * HERE: Enhance / Assemble' — ops that chain onto the audio the step never
 * produced."* (BookForge → Foundry, 2026-08-18, the same-day addendum.) The
 * offer rule was written entirely in terms of what a node PRODUCES, and
 * `produces` on a host node is a promise rather than a fact — deliberately, so
 * that a QUEUED narration can have an enhance chained onto audio that does not
 * exist yet. A failure is the case where the promise is broken and the row is
 * still standing there making it.
 *
 * ── Why a table rather than `state !== 'failed'` ────────────────────────────
 *
 * `PRODUCES_OF`'s reason exactly: a fifth state is a compile error here until
 * somebody says whether you can build on it, rather than silently inheriting
 * whichever side of a `!==` it happens to fall. The addendum names `cancelled`
 * alongside `failed` — THIS BUILD'S `HostNodeState` HAS NO SUCH MEMBER (queued,
 * running, done, failed), so nothing is invented for it here; the day the socket
 * grows one, this table will not compile until it is answered, which is the
 * whole point of writing it this way.
 *
 * QUEUED AND RUNNING STAY TRUE, and that is not an oversight. *"they can chain
 * the next op onto a pending node's future output"* is the ruling the tree was
 * built on, and a run in flight is a promise nobody has broken.
 */
export const CHAINABLE_FROM: Readonly<Record<HostNodeState, boolean>> = {
  queued: true,
  running: true,
  done: true,
  failed: false,
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
  /*
   * STILL ONE COMPARISON after the union grew to three, and keeping it one is
   * what made the growth safe. A member added here as a SPECIAL CASE — "export
   * rows also get the book ops" — would have been the old behaviour preserved by
   * an exception rather than by a rule, and the exception would have had to be
   * remembered at every future member. Export rows produce `export`; a host that
   * wants an act there declares `export`; a host still declaring `book` reaches
   * exactly what it always reached.
   */
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
   * An assemble consumes the narrated audio, so it applies to `audio`. This is
   * the whole of the chaining rule — see `offeredFrom` — and it is declared by
   * the host rather than derived from `kind`, because a host that grew an
   * operation consuming audio and producing audio (an enhance) and one consuming
   * text and producing audio (a narrate) needs to say which is which.
   *
   * ── `book` AND `export` ARE TWO DIFFERENT ASKS, AND THAT IS THE POINT ──────
   *
   * `book` is offered from every LEDGER STEP that has words behind it — a
   * reading, a save, a translation. `export` is offered from `final/` rows and
   * nowhere else. An operation that reads a finished FILE (a narration does)
   * should say `export`, or it will be offered on stages where the only possible
   * outcome is a refusal — which is the ruling this member was added for
   * (`NodeOutput`, shared/types.ts).
   *
   * A HOST STILL SAYING `book` IS NOT BROKEN and is not corrected here. Its
   * operation lands on ledger steps exactly as it always has; this app does not
   * second-guess a declaration, because the host is the only side that knows what
   * its own act consumes.
   */
  appliesTo: NodeOutput;
  /**
   * WHAT TO ASK THE PERSON BEFORE RUNNING IT — declared by the host, drawn by
   * Foundry, and absent for an operation that has nothing to ask.
   *
   * ── The ruling this exists to serve ─────────────────────────────────────────
   *
   * *"Today `bookforge.narrate` raises the BookForge main window and opens its
   * modal there. Owen wants the dialog in the Foundry window, like
   * translate/simplify — and a narrate button on the nav rail besides."*
   * (BookForge → Foundry, 2026-08-18.) A host cannot render into this window —
   * that is the whole reason the socket exists rather than a shared component —
   * so what crosses instead is a DESCRIPTION of the questions, and Foundry
   * renders them in its own dialog language.
   *
   * ── Absent is not empty ─────────────────────────────────────────────────────
   *
   * An operation with no `form` invokes THE INSTANT IT IS PRESSED, exactly as
   * every operation did before this field existed. That is the compatibility
   * promise and it is also the honest reading: a form with no fields is a dialog
   * with a Start button and nothing above it, which is a modal asking somebody to
   * confirm that they meant the thing they just clicked.
   *
   * ── The values are the HOST's and are resolved at mount ─────────────────────
   *
   * *"values resolved live at mount time, so the voice list is current."* Foundry
   * never interprets an option, never validates a choice against anything but the
   * field's own declaration, and never remembers an answer between invocations.
   * It draws what it is given and hands back what was chosen — which is what
   * keeps this app host-agnostic: NO SURFACE IN FOUNDRY SAYS "NARRATE", and the
   * day a host registers an operation about something else entirely, nothing here
   * has to learn a new word.
   */
  form?: readonly HostOpField[];
}

/**
 * ONE QUESTION IN A HOST OPERATION'S FORM.
 *
 * ── Four kinds, and why the list is closed ──────────────────────────────────
 *
 * `select`, `number`, `toggle`, `text` — the shapes BookForge asked for (engine,
 * voice, device, workers) and, not coincidentally, the four a settings form can
 * be built out of without Foundry learning anything about the domain. A closed
 * union rather than an open string is what makes the renderer's switch
 * exhaustive: a fifth kind is a compile error in the dialog rather than a field
 * that silently draws as nothing.
 *
 * WHAT IS DELIBERATELY NOT HERE is conditional logic — no "show this field only
 * when that one is set", no cross-field validation, no dependent option lists. A
 * host that needs those has a decision tree, and a decision tree rendered by an
 * app that does not understand the domain is a form that will eventually
 * contradict itself. The escape hatch is the one that has always existed: an
 * operation with no `form` opens the host's own window, where the host can ask
 * anything it likes.
 *
 * EVERY FIELD IS OPTIONAL EXCEPT `key`, `label` AND `kind`, because a host that
 * has nothing to say about bounds or help should not have to say it. Foundry
 * draws whatever is there and asks nothing of what is not.
 */
export interface HostOpField {
  /**
   * WHAT THE ANSWER IS CALLED when it comes back, and the host's own name for it.
   *
   * It is the key in the `settings` record `invoke` receives, so it is the one
   * string in a form that Foundry must not touch: it goes out exactly as it came
   * in. Unique within a form — a host that repeats one has two questions writing
   * into one answer, which this app cannot detect and will not pretend to.
   */
  key: string;
  /** What the field says above the control. The host's words, drawn verbatim. */
  label: string;
  /** Which control to draw. See the docblock: a closed set, exhaustively handled. */
  kind: 'select' | 'number' | 'toggle' | 'text';
  /**
   * The choices, for a `select` — ignored for every other kind.
   *
   * `value` is what travels back in `settings` and `label` is what the person
   * reads, which is the same split every select in this app makes: a language tag
   * and a language name are not the same string and the day they are conflated is
   * the day a list has to be reordered to change what a choice means.
   */
  options?: readonly { value: string; label: string }[];
  /**
   * What the field starts on, and the whole of Foundry's opinion about an answer
   * nobody changed.
   *
   * A `select` with no default starts on its first option, because a select with
   * nothing chosen would send `undefined` for a question the host said it wanted
   * answered. A `toggle` with no default starts off, a `number` with no default
   * starts blank, and `text` starts empty — the quietest answer available in each
   * case, which is the right one for a form the person may simply press Start on.
   */
  default?: string | number | boolean;
  /** Bounds for a `number`, passed to the control and enforced by nothing else. */
  min?: number;
  max?: number;
  /** One sentence under the control, in the dialog's own note voice. Optional. */
  help?: string;
}

/**
 * WHAT A PERSON MAY DO TO A HOST NODE THAT FAILED.
 *
 * A FIXED PAIR AND NOT AN OPEN LIST, which is the shape decided rather than a
 * simplification: *"Failed nodes want `Retry` and `Dismiss` instead … the
 * cleanest contract is probably a fixed pair of host-node actions the tree
 * renders on failed nodes and reports back over a `host-ops:` channel."* Two
 * verbs every queue engine already has, named by this app so that the tree can
 * draw them without asking the host what its buttons are called — which is the
 * difference between this and `HostOperationOffer`, where the host names
 * everything because the host invented the act.
 *
 * `retry` MEANS RUN IT AGAIN and `dismiss` MEANS TAKE THE ROW AWAY. Foundry does
 * neither: it has no queue of the host's to touch and no row of its own to
 * delete — the node leaves the tree when the host stops pushing it
 * (`setHostNodes`), which is the same way it arrived.
 */
export type HostNodeAction = 'retry' | 'dismiss';
