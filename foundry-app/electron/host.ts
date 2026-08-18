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
import type { ExportLanding, ImportLanding } from '../shared/types';
// A TYPE, and it has to stay one: `host-ops.ts` pushes at windows and therefore
// imports `window.ts`, which is exactly the weight this leaf exists to keep out
// of `app-settings.ts`. `import type` is erased, so the leaf stays a leaf.
import type { HostNodeAction } from '../shared/host-ops';
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
