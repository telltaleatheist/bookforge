import { Injectable, signal } from '@angular/core';

import { offeredFrom } from '@shared/host-ops';
import type { HostNodeAction, HostOperationOffer, HostStatus } from '@shared/host-ops';
import { fold } from '@shared/original';
import type { HostNode, NodeOutput } from '@shared/types';

import { api } from './foundry';

/**
 * The renderer's MIRROR of the host-operations socket — what somebody else's
 * application has contributed to this app's tree.
 *
 * A MIRROR AND NOT A STORE, exactly as `QueueService` and `LedgerService` are:
 * the host owns both halves, main holds them, and this class holds what main
 * last said. Nothing here invents a node, advances a percentage or removes a row
 * when a job looks finished — the host pushes, or the row stands where it is.
 *
 * ── Standalone this class is two empty lists and never calls anything ───────
 *
 * With no host mounted, `offers()` answers `[]` once and no push ever arrives.
 * Every surface that reads this therefore draws nothing extra, and none of them
 * needs to ask whether the app is hosted — which is the whole reason the socket
 * is shaped as lists rather than as a flag with features behind it.
 */
@Injectable({ providedIn: 'root' })
export class HostOpsService {
  /**
   * WHAT THE HOST OFFERS, as of the last thing it said about it.
   *
   * Asked once at first paint and REPLACED BY EVERY PUSH after that. It was
   * asked once and left alone — there is one process and one mount, so it could
   * not change while the page lived — and the thing that reasoning conflated is
   * the one `hosted()` really is: a fact asked once is not the same as a fact
   * that cannot change. A host whose voices were installed while this window was
   * up could not publish them, and the window would have gone on offering the
   * form it was told about at startup until somebody reopened it.
   */
  private readonly registered = signal<readonly HostOperationOffer[]>([]);

  /**
   * WHETHER A FAILED NODE'S RETRY AND DISMISS HAVE ANYWHERE TO GO.
   *
   * The other half of the same answer (`host-ops:offers`), held beside the
   * operations because it is the same fact: what did the host register — and
   * replaced beside them on every revision, because the push carries the whole
   * answer rather than the half that moved. False standalone, and false for a
   * host that contributed operations
   * without a way to retry one — and the tree draws the pair only when it is
   * true, because a button that silently does nothing is the one outcome this
   * socket must not have.
   */
  private readonly actionable = signal(false);

  /**
   * Per project, keyed by the FOLDED directory — on Windows one path arrives
   * spelled three ways, and two spellings would be two sets of rows for one
   * book. Main folds its own side identically (electron/host-ops.ts), so a push
   * and a read for one project always land in one entry here.
   */
  private readonly byProject = signal<ReadonlyMap<string, readonly HostNode[]>>(new Map());

  /** The projects this window has already asked about. See `ensure`. */
  private readonly asked = new Set<string>();

  /**
   * WHAT THE HOST IS DOING RIGHT NOW, or null — the chip in the window's chrome.
   *
   * NOT KEYED BY PROJECT, which is the one way it differs from everything else
   * this class holds. A host node describes a thing being made from a particular
   * book; this describes the host's own queue, which is one queue whichever book
   * is open. Main keeps it the same way (electron/host-ops.ts).
   *
   * NULL IS THE CHIP NOT BEING DRAWN, and it is the starting value: standalone
   * nothing ever sets it, so the chrome is this app's alone by doing nothing at
   * all rather than by a check somebody has to remember.
   */
  private readonly status = signal<HostStatus | null>(null);

  /**
   * WHETHER A CLICK ON THE CHIP HAS ANYWHERE TO GO — `actionable`'s twin, one
   * surface along, and read for the same reason: the affordance is drawn only
   * where somebody is listening, because a chip that looked pressable and did
   * nothing is the one outcome this socket must not have.
   */
  private readonly statusOpenable = signal(false);

  constructor() {
    if (!api) return;
    /*
     * WHAT THE HOST OFFERS: THE FIRST PAINT, AND EVERY REVISION AFTER IT.
     *
     * The read used to be the whole story, because the offers were a mount-time
     * fact and mount happens once. A host may revise them now
     * (`setHostOperations`, electron/mount.ts) — voices installed since,
     * settings changed since — and this is the same arrangement the chip below
     * uses, one surface along.
     *
     * THE SUBSCRIPTION IS ARMED FIRST AND THE READ DEFERS TO IT, for the reason
     * spelled out at the status pair: a round trip takes a turn or two, and a
     * host that revised inside that window would have its push overwritten by an
     * answer composed before it — leaving the menu offering acts the host has
     * already withdrawn until it happened to revise again. `heard` is the whole
     * guard, and it is a local rather than a field because nothing outside this
     * constructor has any business asking whether the first answer was stale.
     *
     * BOTH HALVES ARE REPLACED TOGETHER because the push carries both: it is the
     * same `{operations, nodeActions}` the read answers (`HostOffers`,
     * shared/host-ops.ts), so there is no merge to get wrong and no second shape
     * for one fact.
     */
    let heardOffers = false;
    api.hostOps.onOffersChanged((pushed) => {
      heardOffers = true;
      this.registered.set(pushed.operations);
      this.actionable.set(pushed.nodeActions);
    });
    void api.hostOps.offers().then((answer) => {
      if (heardOffers) return;
      this.registered.set(answer.operations);
      this.actionable.set(answer.nodeActions);
    });
    /*
     * THE CHIP'S FIRST PAINT AND EVERY PUSH AFTER IT. The read exists for the
     * window that opened AFTER the host had already pushed — `ensure`'s reason,
     * without the per-project bookkeeping, because there is one status and this
     * window asks for it once.
     *
     * THE SUBSCRIPTION IS ARMED FIRST AND THE READ DEFERS TO IT. A round trip
     * takes a turn or two, and a host whose queue moved inside that window would
     * have its push overwritten by an answer composed before it — the chip would
     * then sit on a stale line until the host's queue happened to move again.
     * `heard` is the whole guard: once anything has been pushed, the first-paint
     * answer is old news and only its `openable` half is worth keeping.
     */
    let heard = false;
    api.hostOps.onStatusChanged((pushed) => {
      heard = true;
      this.status.set(pushed);
    });
    void api.hostOps.status().then((answer) => {
      this.statusOpenable.set(answer.openable);
      if (!heard) this.status.set(answer.status);
    });
    /*
     * THE WHOLE SET FOR ONE PROJECT, on every push. It replaces rather than
     * merges, which is what makes "it finished and left" expressible at all: a
     * host that stops pushing a node has said the node is gone, and a merge
     * would keep a narration on the tree forever because nothing ever said the
     * word "delete".
     */
    api.hostOps.onChanged(({ projectDir, nodes }) => {
      const key = fold(projectDir);
      this.asked.add(key);
      this.byProject.update((held) => new Map(held).set(key, nodes));
    });
  }

  /**
   * Ask for a project's host nodes if nobody has yet — the call the tree makes
   * before it draws a book.
   *
   * IDEMPOTENT AND SILENT, on `LedgerService.ensure`'s contract exactly: it runs
   * from an effect that re-runs whenever a tab opens, so a project already asked
   * about is a no-op and a refusal is not thrown at a template. The only reason
   * it exists at all is a window that opened AFTER the host had already pushed —
   * every push after this one arrives on its own.
   */
  ensure(projectDir: string): void {
    if (!api) return;
    const key = fold(projectDir);
    if (this.asked.has(key)) return;
    this.asked.add(key);
    void api.hostOps.nodes(projectDir).then((nodes) => {
      this.byProject.update((held) => new Map(held).set(key, nodes));
    });
  }

  /**
   * This project's host nodes, in the order the host pushed them.
   *
   * THE ORDER IS THE HOST'S and is not sorted here. A queue's order is the one
   * fact a queue has that a tree cannot derive — "second in line" is not a
   * timestamp — and re-sorting it would be this app holding a second opinion
   * about somebody else's list.
   *
   * EMPTY FOR A PROJECT NOBODY HAS PUSHED, which is not a fallback standing in
   * for an answer: "the host is making nothing here" and "the host has never
   * mentioned this book" are the same statement from the tree's side.
   */
  nodesFor(projectDir: string | null): readonly HostNode[] {
    if (projectDir === null) return NONE;
    return this.byProject().get(fold(projectDir)) ?? NONE;
  }

  /**
   * The acts offerable from a node that produces this — the "from here" footer's
   * host half.
   *
   * The rule itself is `offeredFrom` in shared/host-ops.ts, so that the tree and
   * anything else that ever asks this question cannot come to two answers.
   */
  offersFor(produces: NodeOutput): readonly HostOperationOffer[] {
    return offeredFrom(this.registered(), produces);
  }

  /**
   * Press one. Main proves the id against what the host registered and runs the
   * host's own function.
   *
   * THE REJECTION IS THE CALLER'S TO SHOW. This deliberately does not catch: the
   * user pressed a button, and if the host refused, the host's sentence is the
   * only useful thing anybody has. The tree puts it on the notice strip.
   */
  async invoke(
    operationId: string,
    projectDir: string,
    nodeId: string,
    /**
     * The answers to the operation's own form, or nothing at all for one that
     * declared none — see `HostOpField` (shared/host-ops.ts).
     *
     * DEFAULTED TO `{}` HERE so that every caller which has no form to answer
     * reads as it always did. What crosses the preload is always an object,
     * because the host is entitled to destructure it.
     */
    settings: Record<string, unknown> = {},
  ): Promise<void> {
    if (!api) return;
    await api.hostOps.invoke(operationId, projectDir, nodeId, settings);
  }

  /**
   * The operation with this id, or null — what the dialog needs to draw itself.
   *
   * ASKED BY ID BECAUSE THAT IS WHAT A DIALOG CAN CARRY. The host-op dialog is
   * opened with a request naming an operation, a project and a node; holding the
   * whole offer in that request would be a copy of something the registry already
   * has, and a copy that would go stale if a host ever re-registered. One
   * lookup, at draw time, against the list that is the authority.
   */
  offer(operationId: string): HostOperationOffer | null {
    return this.registered().find((one) => one.id === operationId) ?? null;
  }

  /**
   * True when the host said it can retry and dismiss its own failed work.
   *
   * READ BY THE TREE BEFORE IT DRAWS THE PAIR. It is a signal rather than a
   * promise because the answer lands one turn after the window opens, and a card
   * drawn in that turn has to grow the buttons when it arrives rather than
   * having been drawn without them forever.
   */
  takesNodeActions(): boolean {
    return this.actionable();
  }

  /**
   * Retry or dismiss one failed host node.
   *
   * THE REJECTION IS THE CALLER'S TO SHOW, on `invoke`'s rule exactly: the person
   * pressed a button, and the host's own sentence is the only useful account of
   * why nothing happened. Foundry changes nothing itself — the row leaves or
   * re-runs when the host pushes its nodes again.
   */
  async nodeAction(projectDir: string, nodeId: string, action: HostNodeAction): Promise<void> {
    if (!api) return;
    await api.hostOps.nodeAction(projectDir, nodeId, action);
  }

  /**
   * WHAT THE HOST IS DOING RIGHT NOW, for the chip in the chrome — null when
   * there is nothing to draw, which is standalone always.
   *
   * The signal itself, handed out rather than copied: the chip reads it in a
   * template and a push has to repaint it. Nothing in this app reads INTO it —
   * the words are the host's and are drawn as they arrived (shared/host-ops.ts).
   */
  hostStatus(): HostStatus | null {
    return this.status();
  }

  /** True when a click on the chip has somewhere to go. See `takesNodeActions`. */
  opensStatus(): boolean {
    return this.statusOpenable();
  }

  /**
   * The chip was clicked. What happens is the host's — raising its own window is
   * the obvious reading and this app neither asks for nor inspects the result.
   *
   * THE REJECTION IS THE CALLER'S TO SHOW, on `invoke`'s rule. It can only be
   * reached by a chip drawn pressable over a host that registered nothing, which
   * is a disagreement worth seeing rather than swallowing.
   */
  async openStatus(): Promise<void> {
    if (!api) return;
    await api.hostOps.openStatus();
  }
}

/**
 * ONE empty array for every project that has none.
 *
 * A fresh `[]` per call would be a new identity on every repaint, and the tree
 * reads this inside a `computed` — so every book with no audio work would
 * invalidate the whole panel on every change detection pass.
 */
const NONE: readonly HostNode[] = [];
