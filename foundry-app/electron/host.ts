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
   * READ ONCE, AT MOUNT. There is one host and one mount, so this is a fact for
   * the lifetime of the process — the same reason `app:hosted` is asked once and
   * never pushed. What DOES change while the app runs is what the host is making
   * (`setHostNodes`), which is a push and is deliberately the other thing.
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
