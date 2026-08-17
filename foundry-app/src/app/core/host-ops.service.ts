import { Injectable, signal } from '@angular/core';

import { offeredFrom } from '@shared/host-ops';
import type { HostNodeAction, HostOperationOffer } from '@shared/host-ops';
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
   * What the host registered at mount — asked once, and once is right: there is
   * one process and one mount, so this cannot change while the page lives (the
   * same fact `hosted()` is, and for the same reason).
   */
  private readonly registered = signal<readonly HostOperationOffer[]>([]);

  /**
   * WHETHER A FAILED NODE'S RETRY AND DISMISS HAVE ANYWHERE TO GO.
   *
   * The other half of the same mount-time answer (`host-ops:offers`), held
   * beside the operations because it is the same fact: what did the host
   * register. False standalone and false for a host that contributed operations
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

  constructor() {
    if (!api) return;
    void api.hostOps.offers().then((answer) => {
      this.registered.set(answer.operations);
      this.actionable.set(answer.nodeActions);
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
}

/**
 * ONE empty array for every project that has none.
 *
 * A fresh `[]` per call would be a new identity on every repaint, and the tree
 * reads this inside a `computed` — so every book with no audio work would
 * invalidate the whole panel on every change detection pass.
 */
const NONE: readonly HostNode[] = [];
