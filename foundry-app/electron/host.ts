/**
 * host — whether this app is running, or being run by somebody else.
 *
 * Foundry is two things at once now: a program with its own icon, and a window
 * BookForge opens over its own data (docs/BOOKFORGE-HANDOFF.md §8). Almost
 * nothing in `app/electron` cares which of the two is happening — the IPC doors,
 * the queue and the engine are the same either way — so the fact is kept in one
 * small module that everything may ask and nothing has to be handed.
 *
 * IT IS A MODULE-LEVEL RECORD BECAUSE MOUNTING IS A PROCESS-LEVEL EVENT. There
 * is one main process, one job queue and one set of `ipcMain` handlers in it, so
 * there is exactly one answer to "who mounted us" for as long as the process
 * lives. Threading it through as an argument would put the same value in twenty
 * signatures for the sake of a second host that cannot exist.
 *
 * A LEAF ON PURPOSE. This imports nothing but a type, so `app-settings.ts` and
 * anything else at the bottom of the graph can ask it without a cycle — which is
 * the whole reason the record is here rather than in `mount.ts`, the module that
 * writes it and that sits at the top of everything.
 */
import type {
  ExportLanding, FoundryJobRow, ImportLanding, JobRequest, TranslateRequest,
} from '../shared/types';
// A TYPE, and it has to stay one: `host-ops.ts` pushes at windows and therefore
// imports `window.ts`, which is exactly the weight this leaf exists to keep out
// of `app-settings.ts`. `import type` is erased, so the leaf stays a leaf.
import type { HostMintMeta, HostNodeAction } from '../shared/host-ops';
import type { HostOperation } from './host-ops';

/**
 * What a host tells Foundry about itself, and the one thing it asks to be told.
 *
 * SMALL DELIBERATELY. Everything else a host might want to configure is either
 * already a file on disk (the engine's settings.json, the app's own knobs) or is
 * not the host's business. What is genuinely the host's is WHERE THE BOOKS LIVE
 * — hosted, they live inside its data directory, not in `~/Documents/Foundry` —
 * and WHAT CAME OUT, because an export is the moment Foundry produces something
 * the host's own pipeline consumes.
 */
/**
 * THE HOST'S OWN QUEUE, offered to Foundry so that ONE SCHEDULER OWNS THE GPU.
 *
 * ── The ruling, and the hazard behind it ────────────────────────────────────
 *
 * Owen, 2026-08-18: *"we need to centralize the queue in bookforge. foundry has
 * their own queue but things shouldnt be queued in foundry's queue from within
 * bookforge."* It is urgent rather than tidy: BookForge's engine schedules on a
 * declared `gpu` resource and Foundry's `pump()` is a second scheduler that
 * knows nothing about it, so a Foundry reading and a host's narration can both
 * hold the same card. One machine's GPU needs one owner.
 *
 * ── The split: they decide WHEN, we still do the WORK ───────────────────────
 *
 * A host that registers this takes over the SCHEDULING and nothing else. It
 * never reimplements the ledger writes, the bank, the rotations or the export
 * landings — two copies of that bookkeeping is how two apps start disagreeing
 * about what a book is. What crosses is: a request goes out (`enqueue`), and
 * the host calls `runJob` on the mount seam when its own pump says now.
 *
 * ── ABSENT IS TODAY, EXACTLY ────────────────────────────────────────────────
 *
 * Standalone Foundry passes no host at all, and a host that has not moved
 * registers no queue: every door below is unreached, `pump()` schedules as it
 * always has, and the shelf draws Foundry's own rows. This is `appliesTo`'s
 * compatibility posture, one socket along — a field nobody sets changes nothing.
 *
 * ── ONLY WHAT A PERSON PRESSED IN THIS WINDOW ROUTES ────────────────────────
 *
 * Work the host itself ordered through the mount seam (`exportEpubFromStep`)
 * stays on Foundry's internal path, deliberately. See `enqueue` there, and the
 * essay at the branch in electron/job-queue.ts: routing a call the host is
 * already awaiting would re-enter the host's scheduler from inside it.
 */
export interface FoundryHostQueue {
  /**
   * FILE THIS WORK IN THE HOST'S QUEUE, and hand back the row that stands for it.
   *
   * SYNCHRONOUS, AND THAT IS PART OF THE CONTRACT rather than a convenience:
   * Foundry's own `enqueue` is synchronous so that the shelf row exists in the
   * same turn as the press, and the IPC door that calls it answers with the row.
   * A host is expected to DEFER ITS OWN PUMP — file the row, return it, start the
   * work on the next turn — so that nothing has begun before this returns.
   *
   * `parentStep` is Foundry's position at the press, resolved by the door before
   * it called (`Job.parentStep`), and it is handed straight back to `runJob`
   * later: it decides what the product is recorded as being made FROM, and a
   * pointer that moves while the row waits must not change that.
   *
   * THE ROW IS THE HOST'S OWN. Its `id` is the host's — it is what `cancel` and
   * `remove` will name — and Foundry mints nothing for it until `runJob` runs it.
   */
  enqueue(request: JobRequest | TranslateRequest, parentStep: string | null): FoundryJobRow;
  /**
   * The gestures the shelf makes, forwarded by id — the host's id, off the host's
   * own row.
   *
   * EACH IS OPTIONAL AND AN ABSENT ONE IS SAID OUT LOUD, never quietly answered
   * by Foundry's own list: the id belongs to a queue this app does not own, so
   * there is nothing here to fall back TO. A host that offers a queue and no
   * `cancel` has said its rows are not cancellable from this window, which is a
   * complete thing to say and is logged where it happens.
   */
  cancel?(id: string): void;
  remove?(id: string): void;
  /** Release whatever the host is holding for a person to press Start on. */
  start?(): void;
  clearFinished?(): void;
  /**
   * EVERY ROW THE HOST HOLDS FOR ONE PROJECT — the first paint, for a window that
   * opened after the host's last push.
   *
   * `setHostNodes`/`hostNodesFor`'s arrangement exactly, and for its reason: the
   * pushes carry every change afterwards, and this is the one message a late
   * window would otherwise have missed. Asked when a window draws a book.
   */
  rows?(projectDir: string): readonly FoundryJobRow[];
}

export interface FoundryHost {
  /**
   * The library root, `<libraryDir>/projects` and all. It wins over the app's
   * own setting for as long as the host is mounted (see `readAppSettings`), and
   * Foundry's settings screen must not offer to change it: it is the host's
   * fact about its own data, not a preference of this app's.
   */
  libraryDir: string;
  /**
   * An export just landed in a project's `final/`. Called after the file is on
   * disk and the tray has recorded it, so a host that files it into a versions
   * list is describing something that exists.
   *
   * Its errors are caught and logged where it is called: a host's mistake must
   * not turn a landed export into a failed job.
   */
  onExport(landing: ExportLanding): void;
  /**
   * A file from outside the library just became a project — the first-contact
   * announcement, so a host that opened the bare window for one of its books
   * can learn which project key Foundry minted for it (`ImportLanding`,
   * shared/types.ts, which carries the why). OPTIONAL where `onExport` is not:
   * exports are the reason a host mounts Foundry at all, while a host may
   * track its books some other way and have no use for first contact.
   *
   * Same error posture as `onExport`: caught and logged at the call.
   */
  onImport?(landing: ImportLanding): void;
  /**
   * A PERSON PRESSED RETRY OR DISMISS ON A HOST NODE THAT FAILED.
   *
   * ── The gesture that had nowhere to happen ──────────────────────────────────
   *
   * A failed narrate card offered chaining and no way out of it, so the only way
   * to clear a failure was to leave for the host's own window and press Clear
   * finished there: *"Works, but it is the wrong window for the gesture."*
   * (BookForge → Foundry, 2026-08-18, the same-day addendum.) This is the door
   * that keeps the gesture where the person is standing.
   *
   * OPTIONAL, AND ITS ABSENCE IS DRAWN. A host that does not register this gets
   * NO Retry and NO Dismiss on its failed cards — the tree asks whether the
   * callback exists before it draws the pair, because a button that silently
   * does nothing is the one outcome this socket must not have. That probe is the
   * `nodeActions` flag on the offers answer (electron/host-ops.ts).
   *
   * ITS REJECTION IS NOT SWALLOWED, which puts it with `hostOperations` and not
   * with the two announcements above. `onExport` and `onImport` are Foundry
   * TELLING the host something that has already happened, so a host's throw must
   * not fail the job; this is a BUTTON, and its rejection travels back over
   * `host-ops:node-action` to be said where the button was.
   *
   * FOUNDRY CHANGES NOTHING ITSELF. A retry is the host's queue running the work
   * again and a dismiss is the host's queue forgetting it; either way what
   * reaches this window is the next `setHostNodes` push, which is how every other
   * fact about a host node arrives.
   */
  onNodeAction?(projectDir: string, nodeId: string, action: HostNodeAction): void | Promise<void>;
  /**
   * SOMEBODY CLICKED THE STATUS CHIP IN FOUNDRY'S CHROME.
   *
   * ── What the chip is, and why the click is optional ─────────────────────────
   *
   * The host pushes a line about its own work (`setHostStatus`,
   * electron/host-ops.ts) and Foundry draws it in the top corner of its window —
   * the one surface in this app's chrome that belongs to somebody else. That
   * much is a READOUT and needs nothing from the host but the words.
   *
   * REGISTERING THIS IS WHAT MAKES THE CHIP CLICKABLE, and not registering it is
   * a complete answer. A host with a window of its own to raise says so here and
   * the chip grows a cursor, a hover and a press; a host with nowhere to send
   * somebody leaves it out and the chip stays a readout, drawn without any
   * affordance suggesting otherwise. That probe is the `openable` field on the
   * status answer (`host-ops:status`), on `onNodeAction`'s rule exactly — a
   * button that silently does nothing is the one outcome this socket must not
   * have.
   *
   * WHAT IT DOES IS ENTIRELY THE HOST'S BUSINESS. Raising its own queue window
   * is the obvious reading and Foundry does not require it: nothing is passed,
   * nothing is expected back, and no change is made in this window. What reaches
   * the chip afterwards is the next `setHostStatus` push, which is how every
   * fact about the host's work arrives.
   *
   * SYNCHRONOUS AND VOID, unlike `onNodeAction`. That one is a button whose
   * outcome the person waits on, so its rejection travels back to be said where
   * the button was; this is "bring your window forward", which either happened
   * or did not, and a person who clicked has already looked away from this
   * window to find out.
   */
  onStatusOpen?(): void;
  /**
   * ACTS THE HOST CONTRIBUTES TO THE PROVENANCE TREE — narration, enhancement,
   * assembly: the audio half of a pipeline whose text half is this app.
   *
   * OPTIONAL, AND EMPTY IS THE STANDALONE SHAPE. A host that registers none —
   * and Foundry's own shell, which passes no host at all — gets a tree with
   * exactly the acts this app has always offered. Nothing about the socket
   * shows up until somebody puts something in it (electron/host-ops.ts holds
   * the whole design; `HostOperation` is declared there because `invoke` is a
   * function and functions do not cross the preload).
   *
   * READ ONCE, AT MOUNT, AND IT IS A FIRST WORD RATHER THAN A LAST ONE. There is
   * one host and one mount, so this field is read exactly once — but what it
   * declares is not frozen by that: `setHostOperations` (electron/mount.ts)
   * replaces the whole list and pushes it at every window, for the host whose own
   * form legitimately changed while the app was up. It was frozen until
   * 2026-08-18, and the thing that reasoning conflated is worth naming: a fact
   * asked once and a fact that cannot change are different, and only `hosted()`
   * is really the second kind.
   *
   * A HOST THAT NEVER REVISES IT IS UNCHANGED IN EVERY RESPECT — this field
   * stands for the life of the process, which is what every host does today.
   * What ALSO changes while the app runs is what the host is making
   * (`setHostNodes`) and what it is doing (`setHostStatus`), and all three are
   * pushes for the same reason: only the host knows when its own state moved.
   */
  hostOperations?: readonly HostOperation[];
  /**
   * THE HOST'S QUEUE, IF IT KEEPS ONE — where work a person presses in this
   * window is filed instead of in Foundry's own list.
   *
   * OPTIONAL, AND ITS ABSENCE IS THE WHOLE OF THE COMPATIBILITY STORY. Foundry's
   * own shell passes no host; a host that has not moved passes no queue; both get
   * the queue this app has always had, scheduled by `pump()`, drawn from Foundry's
   * own rows. Nothing about the socket shows up until somebody puts something in
   * it — `hostOperations`' rule, one field down.
   *
   * READ AT THE DOORS AND NOWHERE ELSE. The routing is decided in the five
   * exported gestures of electron/job-queue.ts and in no function beneath them:
   * everything that actually RUNS a job is one code path, shared by the pump and
   * by `runJob`, so a hosted run and a standalone run cannot drift.
   *
   * See `FoundryHostQueue` above for what a host owes when it registers one, and
   * `runJob`/`setHostQueueRows`/`hostQueueDrained` on the mount seam for the three
   * things Foundry offers back.
   */
  hostQueue?: FoundryHostQueue;
  /**
   * WHO THE HOST SAYS A BOOK IS — the mint modal's seed, for a hosted project
   * whose parent document already has a record (Owen's inheritance ruling,
   * 2026-08-24; `HostMintMeta`, shared/host-ops.ts, carries it and the
   * precedence). OPTIONAL on `onImport`'s rule: a host may keep no metadata
   * worth seeding, and its absence is simply today's blank-first-mint.
   *
   * Null means "no answer" — an unclaimed project, an unreadable manifest —
   * and a THROW is read as null where it is called (`hostMintMeta`, below):
   * this is a seed for a form somebody is about to type over, and a host's
   * mistake must not keep the modal from opening.
   */
  mintMetaFor?(projectDir: string): Promise<HostMintMeta | null>;
}

let host: FoundryHost | null = null;

/** Said once, by `mountFoundry`. */
export function recordHost(who: FoundryHost): void {
  host = who;
}

export function foundryHost(): FoundryHost | null {
  return host;
}

/** Is somebody else running this app? */
export function hosted(): boolean {
  return host !== null;
}

/** The host's library root, or null when Foundry is answering for itself. */
export function hostedLibraryDir(): string | null {
  return host === null ? null : host.libraryDir;
}

/**
 * The host's answer for who this book is, or null — standalone, no callback
 * registered, the host answered null, or the host threw. The swallow is the
 * announcement posture (`onExport`'s), not the button posture: a seed the
 * modal cannot get is a blank form, which is exactly what the modal was
 * before this seam existed.
 */
export async function hostMintMeta(projectDir: string): Promise<HostMintMeta | null> {
  if (host?.mintMetaFor === undefined) return null;
  try {
    return await host.mintMetaFor(projectDir);
  } catch (err) {
    console.error(
      `[host] mintMetaFor threw for ${projectDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
