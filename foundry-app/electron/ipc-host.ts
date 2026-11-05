/**
 * ipc-host — Crucible pairing, and the host-operations socket a host (BookForge) plugs into.
 *
 * Registered by `registerIpc` (ipc.ts), in its order.
 */
import { ipcMain } from 'electron';
import { startPairing, pollPairing } from '@crucible/client';
import { RemotePairingSessions } from '@owen/foundry-core/node/crucible-remote-pairing';
import { crucibleServerNamed, engineClientFor } from '@owen/foundry-core/node/crucible-registry';
import { hosted } from '@owen/foundry-core/node/host';
import { actOnHostNode, hostNodesFor, hostOffers, hostOperationStates, hostOpensStatus, hostStatus, openHostStatus } from '@owen/foundry-core/node/host-ops';
import type { HostNodeAction } from '@owen/foundry-core/shared/host-ops';
import * as queue from '@owen/foundry-core/node/job-queue';
import { invokeHostOperationAt } from '@owen/foundry-core/node/doors-ledger';
import { registerApprovedPairing } from '@owen/foundry-core/node/doors-crucible';

export function registerHostDoors(): void {
  const pairingSessions = new RemotePairingSessions(registerApprovedPairing, startPairing, pollPairing);
  const pairingWindows = new Set<number>();
  ipcMain.handle('foundry:crucible-pair-start', async (event, address: string) => {
    if (hosted()) throw new Error('Manage server connections in the host application.');
    if (typeof address !== 'string' || !address.trim()) throw new Error('Enter the other computer’s address.');
    const owner = event.sender.id;
    if (!pairingWindows.has(owner)) {
      pairingWindows.add(owner);
      event.sender.once('destroyed', () => {
        pairingSessions.cancelOwner(owner);
        pairingWindows.delete(owner);
      });
    }
    return pairingSessions.begin(owner, address.trim());
  });
  ipcMain.handle('foundry:crucible-pair-poll', (event, id: string) => {
    if (hosted()) throw new Error('Manage server connections in the host application.');
    return pairingSessions.poll(event.sender.id, id);
  });
  ipcMain.handle('foundry:crucible-pair-cancel', (event) => pairingSessions.cancelOwner(event.sender.id));
  ipcMain.handle('foundry:crucible-pair-requests', async (_event, name: string) => {
    const entry = crucibleServerNamed(name);
    if (!entry) throw new Error('Choose a registered Crucible server.');
    const client = await engineClientFor(entry);
    return client.listPairingRequests();
  });
  ipcMain.handle('foundry:crucible-pair-decide', async (_event, name: string, id: string, code: string, allow: boolean) => {
    if (typeof allow !== 'boolean') throw new Error('Choose Approve or Deny.');
    const entry = crucibleServerNamed(name);
    if (!entry) throw new Error('Choose a registered Crucible server.');
    const client = await engineClientFor(entry);
    await client.decidePairing(id, code, allow);
  });
  /*
   * ── `foundry:crucible-wsl-upgrade` AND ITS PUSH ARE GONE (PHASE19 §0) ─────
   *
   * They were the two halves of one button, "Set up WSL acceleration", which
   * submitted an `engine/wsl` task to a native Windows engine and followed it.
   * PHASE19 deletes the button on a ruling, not a refactor: Owen, 2026-09-18,
   * *"we should assume they have no idea how to do it and it should do it
   * automatically."* The move is the TRAY's now, decided at every start from
   * facts on disk (§2.3), and an app that could also ask for it would be the
   * second owner of "is this machine moving to the Linux engine".
   *
   * What replaces it on screen is a READOUT, not a control: the outcome the
   * tray writes (§2.2), reached through the three doors below. The one control
   * that survives is §2.5's Try again, and it exists only because a person can
   * change a BIOS setting and want the machine looked at again.
   */
  /**
   * Is this window Foundry's own, or is it standing inside another app?
   *
   * ── Why the renderer is told at all ─────────────────────────────────────────
   *
   * Because a few things on screen are answers to questions the host has already
   * answered, and showing them twice is worse than showing them once. The library
   * folder is the first: hosted, the books live in the host's data directory and
   * the control that moves them is a control that would strand the host's own
   * mappings, so it goes (see `library:set`). Home is the next: hosted, the book
   * list is BookForge's, and two library screens are two answers to "what books
   * do I have".
   *
   * ASKED ONCE AND NEVER PUSHED. Nothing can mount a host halfway through a
   * session — `mountFoundry` runs before the window is opened and there is one
   * process — so this is a fact for the lifetime of the page, and an event
   * channel for it would be a subscription that never fires.
   */
  ipcMain.handle('app:hosted', () => hosted());

  /*
   * ── THE HOST-OPERATIONS SOCKET — a family BookForge owns nothing in ───────
   *
   * `host-ops:` was chosen for exactly that reason. Hosting is additive only
   * while no FULL channel name is shared, and every family this app has ever
   * used was audited against the host's registry once (docs/IPC-CHANNELS.md);
   * a brand-new family with a hyphen in it cannot collide with anything, so
   * the socket is collision-safe by construction rather than by re-running an
   * audit every time it grows a door. It has grown three since — the
   * failed-node pair and the chrome's status chip — and that promise is what
   * made each of them free. A fourth name arrived on 2026-08-18 and is NOT a
   * door: `host-ops:offers-changed` is a broadcast, so it is registered where
   * every push in this app is (`broadcast`, electron/window.ts) and the count
   * below is unchanged by it.
   *
   * EVERY ONE IS REGISTERED WHETHER OR NOT ANYBODY MOUNTED A HOST. The
   * renderer asks the same questions in both worlds and gets an empty list or a
   * null standalone (electron/host-ops.ts): a door that existed only when hosted
   * would be a renderer that has to know which world it woke up in before it
   * can draw a tree.
   */
  /*
   * WHAT THE HOST REGISTERED AT MOUNT — the operations, and whether a failed
   * node's Retry and Dismiss have anywhere to go.
   *
   * IT ANSWERS AN OBJECT RATHER THAN AN ARRAY, and the shape change is the
   * cheapest of the three ways to let the tree ask that second question: it is
   * the same question as the first (what did the host register), asked in the
   * same round trip the renderer already makes at startup, and it adds no channel
   * name for BookForge's collision keeper to audit. See `hostTakesNodeActions`.
   *
   * AND THE ANSWER IS COMPOSED WHERE THE PUSH COMPOSES IT. `host-ops:offers-changed`
   * carries this very shape now that a host may revise its acts, and a door and a
   * broadcast spelling one fact twice are two answers waiting to disagree — so
   * both are `hostOffers()` and there is no second literal to keep in step.
   */
  ipcMain.handle('host-ops:offers', () => hostOffers());
  /*
   * ONE PROJECT'S HOST NODES — and, on the way past, the host's QUEUE rows for it.
   *
   * ── Why two answers ride one ask ──────────────────────────────────────────
   *
   * This is the moment main learns that a window is drawing a particular book,
   * and it is the only such moment: `queue:list` is global and names no project,
   * because the shelf has always been one list across the library. A host that
   * keeps its own queue pushes per project (`setHostQueueRows`), so a window that
   * opened AFTER the host's last push would draw an empty shelf until something
   * moved — the same gap `hostNodesFor` exists to close for the tree, one line up.
   *
   * IT ADDS NO CHANNEL, which is the reason it rides here rather than arriving as
   * a door of its own: the count in docs/IPC-CHANNELS.md stays where it is and
   * BookForge's keeper has nothing new to audit. A host that offers no `rows` is
   * unaffected, and standalone the seed is a function call that returns at its
   * first line.
   */
  ipcMain.handle('host-ops:nodes', (_event, projectDir: string) => {
    queue.seedHostQueueRows(projectDir);
    return hostNodesFor(projectDir);
  });
  /*
   * How the host's stateful acts stand at one node — asked when a card is picked,
   * so a tile can say an act is already done there (`HostOperationState`).
   */
  ipcMain.handle('host-ops:state', (_event, projectDir: string, nodeId: string) =>
    hostOperationStates(projectDir, nodeId));
  /*
   * The user pressed one of the host's acts, from a node in the tree.
   *
   * MAIN OWNS THE FUNCTION AND THE RENDERER OWNS ONLY THE ID — the operation is
   * looked up in what the host registered at mount, and an id nothing registered
   * is a refusal naming it. The rejection is deliberately NOT caught: this is a
   * button, and the tree puts the host's own sentence on the notice strip when
   * it fails. See `HostOperation.invoke`.
   */
  ipcMain.handle(
    'host-ops:invoke',
    /*
     * `settings` IS THE THIRD ARGUMENT AND IT IS THE ANNOUNCED CHANGE — the
     * answers to the form the operation declared, or `{}` for one that declared
     * none (see `HostOperation.invoke`, electron/host-ops.ts). Defaulted at the
     * door as well as inside, because a renderer built against the older preload
     * would send two arguments and must go on working rather than handing the
     * host `undefined` for a record it is entitled to destructure.
     */
    /*
     * AND THE FOURTH ARGUMENT IS COMPOSED HERE RATHER THAN SENT — see
     * `HostInvokeContext` (shared/host-ops.ts). It is what FOUNDRY knows about the
     * position, so it is read off the ledger in main, at the moment of the press,
     * and not taken from a renderer that holds a mirror of the same file: a mirror
     * that had not caught up would tell somebody else's queue that a book was
     * cleaned when it was not.
     */
    (
      _event,
      operationId: string,
      projectDir: string,
      nodeId: string,
      settings: Record<string, unknown> = {},
    ) => invokeHostOperationAt(operationId, projectDir, nodeId, settings),
  );

  /*
   * RETRY OR DISMISS A HOST NODE THAT FAILED.
   *
   * ── Why it is a door of its own and not another operation ─────────────────
   *
   * An operation is the HOST's — it has an id the host minted, a label the host
   * wrote, and a rule about what it may be chained onto. These two are FOUNDRY's
   * words for a thing every queue has: the tree draws them itself, on a fixed
   * pair (`HostNodeAction`), so that a failed card has a way out of it without
   * the host having had to think of registering one. Routing them through
   * `host-ops:invoke` would have meant inventing operation ids on this side and
   * hoping no host ever used the same string.
   *
   * THE REJECTION IS DELIBERATELY NOT CAUGHT, exactly as with `invoke`: this is a
   * button, the tree says the host's sentence where the button was, and a button
   * that appears to do nothing is the one outcome this socket must not have. A
   * host that registered no callback is refused BY NAME here rather than silently
   * — though the tree does not draw the buttons at all in that case, so the only
   * way to see it is a renderer and a host that disagree.
   */
  ipcMain.handle(
    'host-ops:node-action',
    (_event, projectDir: string, nodeId: string, action: HostNodeAction) =>
      actOnHostNode(projectDir, nodeId, action),
  );

  /*
   * ── THE STATUS CHIP — the one thing a host may draw in this window's chrome ─
   *
   * WHAT THE HOST IS DOING NOW, AND WHETHER A CLICK ON IT GOES ANYWHERE.
   *
   * Both in one answer, on `host-ops:offers`' precedent exactly: they are read
   * out of one registration, they are wanted in the same breath by the same
   * component, and a second channel for the probe would be one more name for
   * BookForge's collision keeper to audit for a boolean. Null standalone and
   * null for a host that has pushed nothing, which is the chip not being drawn
   * at all — the chrome is Foundry's alone unless somebody says otherwise
   * (shared/host-ops.ts, `HostStatus`).
   */
  ipcMain.handle('host-ops:status', () => ({
    status: hostStatus(),
    openable: hostOpensStatus(),
  }));
  /*
   * THE CHIP WAS CLICKED. What that means is the host's own — raising its queue
   * window is the obvious reading and Foundry neither requires nor inspects it
   * (`FoundryHost.onStatusOpen`).
   *
   * IT REFUSES BY NAME for a host that registered nothing, and the renderer
   * should never send it in that case: the chip is drawn WITHOUT a press when
   * `openable` is false, so the only way to reach this sentence is a renderer
   * and a host that disagree about what was registered. Said out loud rather
   * than returned quietly, on `host-ops:invoke`'s rule.
   */
  ipcMain.handle('host-ops:status-open', () => openHostStatus());
}
