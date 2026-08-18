/**
 * host-ops — the main-process half of the host-operations socket: what a host
 * registered, what a host is currently making, and the one way to set either
 * running.
 *
 * ── Why it is a module beside `host.ts` and not part of it ──────────────────
 *
 * `host.ts` is a LEAF — it imports one type, so anything at the bottom of the
 * graph may ask "am I hosted" without a cycle. This holds mutable per-project
 * state and pushes at windows, which means it imports `window.ts`, and putting
 * that inside the leaf would drag a BrowserWindow into `app-settings.ts`. Two
 * small modules, one of which stays importable from everywhere.
 *
 * ── What lives here, and how long ───────────────────────────────────────────
 *
 * Both halves are process-level and both die with the process, which is right
 * for what they are. The OPERATIONS are the host's declaration — made at mount,
 * and revisable afterwards with `setHostOperations` for a host whose own form
 * legitimately changed while the window was up (voices installed since, settings
 * changed since). They were fixed for the life of the process until 2026-08-18,
 * on the reasoning that `mountFoundry` runs once; what that missed is that a
 * mount-time answer and an UNCHANGING one are not the same thing, and the socket
 * had no way to say so out loud. The NODES are a mirror of the host's own queue,
 * and a mirror is not a store: Foundry writes none of this to disk, reconciles
 * none of it on startup, and remembers
 * nothing about a project the host stops talking about. If BookForge restarts
 * and pushes nothing, there were never any audio nodes, which is the honest
 * answer — the queue that knew about them is gone too.
 *
 * ── And nothing in here can happen standalone ───────────────────────────────
 *
 * With no host there are no operations to offer and nobody to push nodes, so
 * every door below answers empty and the tree draws exactly what it drew before
 * the socket existed. That is the standalone guarantee, and it is a consequence
 * of the arrangement rather than a flag anybody has to remember to check.
 */
import type { HostNode, HostOperationKind, NodeOutput } from '../shared/types';
import type { HostNodeAction, HostOffers, HostOperationOffer, HostStatus } from '../shared/host-ops';
import { fold } from '../shared/original';
import { broadcast } from './window';

/**
 * ONE OPERATION A HOST CONTRIBUTES — the offer, plus the doing.
 *
 * `invoke` is a function in the HOST's main process, which is why this type
 * lives on this side of the preload and only the offer half crosses it. What the
 * renderer sends is an id; this module turns the id back into the function, and
 * a renderer that invented an id gets a refusal naming what it asked for.
 *
 * ── What `invoke` is handed, and what it is expected to do ──────────────────
 *
 * `(projectDir, nodeId, settings)`. The project is the folder Foundry's own doors
 * take, so a host can look the book up in whatever mapping it keeps. The node is
 * WHAT THE USER PRESSED "FROM HERE" ON — a ledger step id when the act was
 * ordered from something Foundry made, one of the host's OWN node ids when it was
 * chained onto work that has not happened yet, and (since the export rows began
 * offering operations) the step an EXPORT was made from. The host can tell them
 * apart because it minted one of them; that is the whole of how chaining is
 * expressed.
 *
 * ── `settings` IS THE SIGNATURE CHANGE, AND IT IS THE ANNOUNCED ONE ─────────
 *
 * The third argument arrived with the in-window dialog (BookForge → Foundry,
 * 2026-08-18): *"Foundry renders a generic dialog from `form` … and
 * `invoke(projectDir, nodeId)` grows a third argument: `settings:
 * Record<string, unknown>` — the user's answers."* It is the answers to the
 * fields the operation declared in `HostOperationOffer.form`, keyed by each
 * field's own `key`, untouched by this app on the way through.
 *
 * AN EMPTY OBJECT IS THE ORDINARY VALUE and never `undefined`: an operation that
 * declared no form is pressed and runs, and it is handed `{}` rather than
 * nothing, so a host destructuring the argument does not have to guard it. That
 * is the compatibility shape — a host written against the two-argument signature
 * keeps working untouched, because JavaScript ignores an argument nobody named.
 *
 * FOUNDRY VALIDATES NOTHING IN IT. The values are whatever the declared controls
 * produced — a string for a select and a text box, a number for a number, a
 * boolean for a toggle — and the host is the only side that knows what any of
 * them mean. `Record<string, unknown>` rather than a generic is deliberate: a
 * type this app could check would be a type this app would have to understand.
 *
 * IT MAY BE ASYNCHRONOUS AND ITS REJECTION IS NOT SWALLOWED, which is where this
 * parts company with `onExport`. A landed export has already happened and a
 * host's throw must not fail the job that made it; an invoke is a button the
 * user just pressed, and a button that silently does nothing is the worst
 * outcome available. So the rejection travels back over the invoke channel and
 * the tree says what the host said.
 */
export interface HostOperation extends HostOperationOffer {
  invoke(
    projectDir: string,
    nodeId: string,
    settings: Record<string, unknown>,
  ): void | Promise<void>;
}

let operations: readonly HostOperation[] = [];

/**
 * Said by `mountFoundry` when a host passed some, and again by
 * `setHostOperations` whenever the host revises them.
 *
 * REPLACES RATHER THAN APPENDS, and that is what makes a revision expressible at
 * all: the host sends the whole list it now offers and this becomes it, so an
 * operation the host has dropped is gone rather than lingering because nothing
 * ever said the word "remove". `setHostNodes`' rule, one surface along.
 *
 * IT IS THE QUIET HALF. This writes and says nothing; `setHostOperations` below
 * writes and tells every window. Mount uses this one because there is no window
 * to tell yet — `registerIpc` and the first load both come after — and a
 * broadcast into an empty list of windows is a message nobody could have heard.
 */
export function recordHostOperations(offered: readonly HostOperation[]): void {
  operations = [...offered];
}

/**
 * EVERYTHING THE HOST HAS ON OFFER, composed in ONE PLACE — the body of the
 * `host-ops:offers` answer and the payload of every `host-ops:offers-changed`
 * push.
 *
 * One function rather than two object literals, on `HostOffers`' argument
 * (shared/host-ops.ts): a window that asked and a window that was pushed at must
 * hold the same fact, and the only way to guarantee that is for both to be this
 * expression. `nodeActions` is re-read here rather than passed in, because
 * whether the host takes retries is a fact about the callback it registered and
 * not about the list it is revising — a host that changed its voices has not
 * changed whether Retry has anywhere to go.
 */
export function hostOffers(): HostOffers {
  return { operations: hostOperationOffers(), nodeActions: hostTakesNodeActions() };
}

/**
 * THE PUSH DOOR FOR THE OFFERS THEMSELVES: this is what the host offers, as of
 * now.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * `host-ops:offers` is asked ONCE, in the renderer's constructor, and until this
 * existed nothing could revise it — so a host whose form legitimately changed
 * while the window was up (a voice installed since, a setting changed since, an
 * operation it can no longer offer) had no way to publish it. A re-ask was the other
 * candidate and the push is better for `setHostStatus`' reason exactly: only the
 * host knows when its own state moved, and a renderer polling for a change it
 * cannot predict is a renderer guessing at somebody else's schedule.
 *
 * `setHostStatus`'s MECHANICS, DELIBERATELY IDENTICAL. The whole value on every
 * change rather than a diff, because a diff between two processes goes wrong
 * silently and stays wrong; no validation, because this app cannot know what the
 * host's acts are; and the window redraws from what it was last given.
 *
 * NOTHING IS PUSHED STANDALONE, because nothing calls this: with no host there
 * is no revision to make, the renderer's one ask answers empty as it always did,
 * and a Foundry nobody mounted is unchanged in every respect.
 */
export function setHostOperations(offered: readonly HostOperation[]): void {
  recordHostOperations(offered);
  broadcast('host-ops:offers-changed', hostOffers());
}

/**
 * What the renderer may be told about them — everything except the doing.
 *
 * The strip is explicit rather than a spread, so a host that hangs extra state
 * off its operation object cannot have it serialised across the preload by
 * accident. What crosses is exactly the fields the renderer draws — and `invoke`,
 * which is a function in the host's process, could not cross even if it were
 * listed.
 *
 * `form` JOINS THEM AND IS OMITTED WHEN ABSENT rather than sent as `undefined`.
 * The renderer's test is "does this operation have a form", and a key that is
 * present holding nothing is a shape that answers that question differently
 * depending on whether it is asked with `in` or with a truth test. Omitted, the
 * two agree.
 */
export function hostOperationOffers(): HostOperationOffer[] {
  return operations.map((operation) => ({
    id: operation.id,
    label: operation.label,
    kind: operation.kind,
    appliesTo: operation.appliesTo,
    ...(operation.form !== undefined ? { form: operation.form } : {}),
    /*
     * AND THE SUBMIT WORD, OMITTED WHEN ABSENT for `form`'s reason exactly: the
     * dialog's test is "did the host declare one", and a key present holding
     * nothing answers that differently depending on how it is asked. THE STRIP
     * IS EXPLICIT, so a field added to the offer type and forgotten here simply
     * never reaches the renderer — which is why this list is worth the two lines
     * per field it costs.
     */
    ...(operation.submitLabel !== undefined ? { submitLabel: operation.submitLabel } : {}),
  }));
}

/**
 * Run one, by the id the renderer named.
 *
 * THE ID IS PROVED AGAINST THE REGISTRY, which is the whole security story of
 * this door: the renderer cannot name a function, only an operation the host
 * itself registered at mount time, and an id nothing registered is a refusal
 * rather than a silent return. The refusal names the id, because the only way to
 * see one is a renderer and a host that disagree about what is on offer.
 */
export async function invokeHostOperation(
  operationId: string,
  projectDir: string,
  nodeId: string,
  /**
   * The answers to the operation's own `form`, or `{}` for one that has none.
   *
   * DEFAULTED HERE AS WELL AS AT THE DOOR, because this function is exported and
   * a caller inside main that has no form to answer should not have to write an
   * empty object to say so. See `HostOperation.invoke` for why the host is
   * always handed an object.
   */
  settings: Record<string, unknown> = {},
): Promise<void> {
  const operation = operations.find((one) => one.id === operationId);
  if (operation === undefined) {
    throw new Error(`No operation called ${operationId} is registered by this app's host.`);
  }
  await operation.invoke(projectDir, nodeId, settings);
}

/**
 * WHETHER THE HOST CAN BE TOLD ABOUT A FAILED NODE — the probe the tree draws by.
 *
 * ── Why the tree has to ask at all ──────────────────────────────────────────
 *
 * `onNodeAction` is optional (electron/host.ts): a host may contribute
 * operations and still have no way to retry or forget one. Retry and Dismiss are
 * therefore drawn ONLY where somebody is listening, because *"a button that
 * silently does nothing is the socket's one forbidden outcome"* — the same rule
 * that makes the invoke door refuse an unregistered id by name rather than
 * returning quietly.
 *
 * ── IT RIDES ON THE OFFERS ANSWER RATHER THAN ON A DOOR OF ITS OWN ──────────
 *
 * The choice was a second handle (`host-ops:can-act`) against a field on the one
 * the renderer already calls at startup, and the field won on three counts: it is
 * the SAME QUESTION — what did the host register at mount — asked in the same
 * round trip; it adds no channel name for BookForge's collision keeper to audit;
 * and it cannot go stale relative to the operations, because both are read out of
 * one registration in one call. The cost is that `host-ops:offers` answers an
 * object rather than an array, which is a payload change inside a channel Foundry
 * owns both ends of.
 */
let nodeActions: ((projectDir: string, nodeId: string, action: HostNodeAction) => void | Promise<void>) | null = null;

/** Said once, by `mountFoundry`, and only when the host registered the callback. */
export function recordHostNodeActions(
  handler: (projectDir: string, nodeId: string, action: HostNodeAction) => void | Promise<void>,
): void {
  nodeActions = handler;
}

/** True when a failed node's Retry and Dismiss have somewhere to go. */
export function hostTakesNodeActions(): boolean {
  return nodeActions !== null;
}

/**
 * Retry or dismiss one failed host node, by the id the renderer named.
 *
 * IT REFUSES BY NAME RATHER THAN RETURNING QUIETLY, on `invokeHostOperation`'s
 * rule: the only way to see this is a renderer drawing a button the host cannot
 * answer, and a silent return would make that look like a working button.
 * Foundry does nothing to the node itself — a retry is the host's queue running
 * the work again, a dismiss is the host's queue forgetting it, and what reaches
 * this window either way is the next `setHostNodes` push.
 */
export async function actOnHostNode(
  projectDir: string,
  nodeId: string,
  action: HostNodeAction,
): Promise<void> {
  if (nodeActions === null) {
    throw new Error(
      'The app Foundry is running inside does not offer retry or dismiss for its own work.',
    );
  }
  await nodeActions(projectDir, nodeId, action);
}

/**
 * Every project's host nodes, keyed by the FOLDED directory.
 *
 * Folded for the reason every path key in this app is folded: on Windows one
 * directory arrives spelled three ways, and a host that pushed under
 * `E:\Bookforge\foundry\projects\Twain-a1b2` and a renderer that asked under
 * `e:/bookforge/...` would be two spellings of one project holding two sets of
 * rows. What is kept unfolded is what goes back out in the push — the host's own
 * spelling, which is what the renderer matches its project rows against.
 */
const nodesByProject = new Map<string, { dir: string; nodes: readonly HostNode[] }>();

/**
 * THE PUSH DOOR: this is what a host is making in this project, as of now.
 *
 * ── Why the whole set rather than a change ──────────────────────────────────
 *
 * `queue:changed` sends the whole job list on every mutation for the same
 * reason: a diff protocol between two processes is a thing that goes wrong
 * silently — one dropped message and the tree is describing a queue that moved
 * on — and the set is a handful of rows. Whole-set also gives "it is finished
 * and gone" for free: the host pushes without it and the card leaves.
 *
 * AN EMPTY SET IS A REAL STATEMENT and is kept as one. It means "nothing of mine
 * is here any more", which a window that arrives later must be able to read as
 * an answer rather than as silence — so the entry stays in the map holding an
 * empty list rather than being deleted.
 *
 * IT DOES NOT VALIDATE THE PARENT. A `parentStepId` naming a step this project
 * does not have draws nothing, and that is the right failure: the tree hangs
 * host nodes off the ledger step it finds, so an unmatched node is simply not
 * drawn, and Foundry refusing a push would be Foundry asserting it knows the
 * host's mapping better than the host does. The host learns its ids from an
 * invoke this app made.
 */
export function setHostNodes(projectDir: string, nodes: readonly HostNode[]): void {
  nodesByProject.set(fold(projectDir), { dir: projectDir, nodes: [...nodes] });
  broadcast('host-ops:changed', { projectDir, nodes });
}

/**
 * What a window asks when it first draws a book — the first paint, for a window
 * that opened after the host had already pushed.
 *
 * EMPTY IS NOT A FALLBACK HERE. A project with no host nodes and a project the
 * host has never mentioned are the same fact from the tree's side — there is
 * nothing of anybody else's to draw — and there is no third answer worth
 * telling apart.
 */
export function hostNodesFor(projectDir: string): readonly HostNode[] {
  return nodesByProject.get(fold(projectDir))?.nodes ?? [];
}

/**
 * WHAT THE HOST IS DOING RIGHT NOW, or null — the chip in this window's chrome.
 *
 * ONE VALUE FOR THE PROCESS, and not one per project, which is the difference
 * between this and `nodesByProject` above. A host node describes a thing being
 * made FROM A PARTICULAR BOOK and belongs on that book's tree; a status
 * describes the host's own queue, which is one queue no matter which book this
 * window happens to be standing in. Keying it by project would make the chip go
 * blank when somebody opened a second book, which is precisely the moment they
 * would want to know what was still running.
 *
 * NULL IS THE STARTING VALUE AND THE ENDING ONE. Standalone nobody ever writes
 * it; hosted, the host clears it with `setHostStatus(null)` when its queue
 * drains, and the chip leaves the chrome. Both are the same state and neither is
 * a fallback standing in for an answer.
 */
let status: HostStatus | null = null;

/**
 * THE OTHER PUSH DOOR: this is what the host is doing, as of now.
 *
 * `setHostNodes`'s mechanics exactly, and for its reasons — the whole value on
 * every change rather than a diff, because a diff between two processes is a
 * thing that goes wrong silently and stays wrong, and this one is four fields.
 * The host is expected to call it on every movement of its own queue; Foundry
 * has no timer, polls nothing, and advances no number by itself.
 *
 * NULL IS A REAL STATEMENT and is pushed like any other. It means "I have
 * nothing to say", the chip leaves, and the chrome is Foundry's alone — the
 * standalone appearance, reached from the hosted state, which is what makes the
 * chip conditional by construction rather than by a flag somebody has to
 * remember to check.
 *
 * NOTHING IN THE VALUE IS VALIDATED. A percent above a hundred, a headline of
 * three hundred characters, a pending count that disagrees with the nodes on the
 * tree: all of them are drawn as given. This app cannot know what the host's
 * queue holds, so a correction here would be a guess overwriting the only side
 * that knows (shared/host-ops.ts carries the whole of that rule).
 */
export function setHostStatus(pushed: HostStatus | null): void {
  status = pushed;
  broadcast('host-ops:status-changed', pushed);
}

/**
 * What a window asks when it first paints — for a window that opened after the
 * host had already pushed.
 *
 * `hostNodesFor`'s reason exactly: every push after this one arrives on its own,
 * and this is the one message a late window would otherwise have missed.
 */
export function hostStatus(): HostStatus | null {
  return status;
}

/**
 * WHETHER A CLICK ON THE CHIP HAS ANYWHERE TO GO — the probe the chrome draws by.
 *
 * `hostTakesNodeActions`'s rule, one surface along: `onStatusOpen` is optional
 * (electron/host.ts), so a host may describe its queue without offering a way
 * into it, and a chip that looked pressable and did nothing would be the one
 * outcome this socket must not have. Registered, the chip is a button; not
 * registered, it is a readout — and the difference is visible before anybody
 * touches it.
 */
let statusOpen: (() => void) | null = null;

/** Said once, by `mountFoundry`, and only when the host registered the callback. */
export function recordHostStatusOpen(handler: () => void): void {
  statusOpen = handler;
}

/** True when the chip has somewhere to send a click. */
export function hostOpensStatus(): boolean {
  return statusOpen !== null;
}

/**
 * The chip was clicked: ask the host to open whatever it thinks this is about.
 *
 * WHAT THAT MEANS IS ENTIRELY THE HOST'S. Raising its own queue window is the
 * obvious reading and it is not the only one — Foundry passes nothing, decides
 * nothing, and changes nothing here afterwards; the next `setHostStatus` push is
 * the only thing that reaches this window.
 *
 * IT REFUSES BY NAME RATHER THAN RETURNING QUIETLY, on `actOnHostNode`'s rule.
 * The renderer does not draw a pressable chip without the probe above, so the
 * only way to see this sentence is a renderer and a host that disagree — which
 * is exactly the case a silent return would hide.
 *
 * SYNCHRONOUS, UNLIKE THE INVOKE DOORS, because the callback is: raising a
 * window is not work anybody waits on, and a signature that could be awaited
 * would invite a host to do something here that the person who clicked would
 * have to stand still for. A throw still travels back over the door — the
 * handler is a promise on the renderer's side either way.
 */
export function openHostStatus(): void {
  if (statusOpen === null) {
    throw new Error(
      'The app Foundry is running inside did not offer anywhere for this to open.',
    );
  }
  statusOpen();
}

/*
 * Re-exported so a host that types its own operation array has one import for
 * the whole socket, and so `mount.ts` — the seam a host actually reads — can
 * hand these on without pretending to own them.
 */
export type { HostNode, HostOperationKind, HostOperationOffer, NodeOutput };
export type { HostNodeAction } from '../shared/host-ops';
export type { HostOpField } from '../shared/host-ops';
export type { HostStatus } from '../shared/host-ops';
export type { HostOffers } from '../shared/host-ops';
