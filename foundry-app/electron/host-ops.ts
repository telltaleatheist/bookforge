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
 * for what they are. The OPERATIONS are the host's mount-time declaration and
 * cannot change while the process lives (`mountFoundry` runs once). The NODES
 * are a mirror of the host's own queue, and a mirror is not a store: Foundry
 * writes none of this to disk, reconciles none of it on startup, and remembers
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
import type { HostOperationOffer } from '../shared/host-ops';
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
 * `(projectDir, nodeId)`. The project is the folder Foundry's own doors take, so
 * a host can look the book up in whatever mapping it keeps. The node is WHAT THE
 * USER PRESSED "FROM HERE" ON — a ledger step id when the act was ordered from
 * something Foundry made, or one of the host's OWN node ids when it was chained
 * onto work that has not happened yet. The host can tell the two apart because
 * it minted one of them; that is the whole of how chaining is expressed.
 *
 * IT MAY BE ASYNCHRONOUS AND ITS REJECTION IS NOT SWALLOWED, which is where this
 * parts company with `onExport`. A landed export has already happened and a
 * host's throw must not fail the job that made it; an invoke is a button the
 * user just pressed, and a button that silently does nothing is the worst
 * outcome available. So the rejection travels back over the invoke channel and
 * the tree says what the host said.
 */
export interface HostOperation extends HostOperationOffer {
  invoke(projectDir: string, nodeId: string): void | Promise<void>;
}

let operations: readonly HostOperation[] = [];

/**
 * Said once, by `mountFoundry`, and only when a host passed some.
 *
 * REPLACES RATHER THAN APPENDS. There is one host and one mount; a second call
 * is a bug in the host's startup, and `mountFoundry` itself already refuses to
 * be idempotent about registration (`ipcMain.handle` throws on the second
 * mount), so this cannot be reached twice by anything but a test.
 */
export function recordHostOperations(offered: readonly HostOperation[]): void {
  operations = [...offered];
}

/**
 * What the renderer may be told about them — everything except the doing.
 *
 * The strip is explicit rather than a spread, so a host that hangs extra state
 * off its operation object cannot have it serialised across the preload by
 * accident. What crosses is exactly the four fields the tree draws.
 */
export function hostOperationOffers(): HostOperationOffer[] {
  return operations.map((operation) => ({
    id: operation.id,
    label: operation.label,
    kind: operation.kind,
    appliesTo: operation.appliesTo,
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
): Promise<void> {
  const operation = operations.find((one) => one.id === operationId);
  if (operation === undefined) {
    throw new Error(`No operation called ${operationId} is registered by this app's host.`);
  }
  await operation.invoke(projectDir, nodeId);
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

/*
 * Re-exported so a host that types its own operation array has one import for
 * the whole socket, and so `mount.ts` — the seam a host actually reads — can
 * hand these on without pretending to own them.
 */
export type { HostNode, HostOperationKind, HostOperationOffer, NodeOutput };
