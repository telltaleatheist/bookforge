/**
 * The Adopt door's wire shapes — declared where BOTH ends compile against them.
 *
 * `electron/foundry-adopt.ts` produces these, `electron/preload.ts` carries them
 * across, and the Add modal draws them. That is three programs' worth of
 * tsconfig (main, preload, renderer) and exactly the situation `shared/` exists
 * for: the renderer cannot import out of `electron/`, so a shape declared there
 * would have to be spelled a second time in `src/`, and the second spelling is
 * the one that goes stale the day a field is added.
 *
 * Types only. This file compiles to nothing.
 */

/** One project the Adopt door can offer. */
export interface AdoptableFoundryProject {
  /** The book's name, as Foundry's own catalogue has it. */
  title: string;
  /** The project key — the folder's name, and what a mapping records. */
  key: string;
  /** The folder, absolute. What `adoptFoundryProject` is handed. */
  dir: string;
  /**
   * Which half of the search found it.
   *
   * `'standalone'` — Foundry's own library, outside BookForge entirely. Adopting
   * one COPIES it in; the original stays where it is.
   * `'hosted'` — already under `<library>/foundry/projects`, and simply mapped
   * by no book. An orphan: nothing is copied, only joined.
   */
  origin: 'standalone' | 'hosted';
  /** When the project's catalogue was last written, ISO. The "edited" date. */
  modifiedAt: string;
  /** Whether its `final/` already holds exports that would land as versions. */
  hasExports: boolean;
  /** `pdf` or `epub` — what the book would be made from. */
  originalKind: 'pdf' | 'epub';
}

/** The whole answer to one press of Adopt. */
export type AdoptResult =
  | {
      outcome: 'adopted';
      /** The BookForge project it minted, or the one it joined. */
      projectId: string;
      bookDir: string;
      key: string;
      /** True when a book was created; false when an existing one was joined. */
      minted: boolean;
      /** True when the project's folder was copied into the hosted root. */
      copied: boolean;
      sourceVariantId: string | null;
      /** Exports that became versions in the reconcile that followed. */
      exportsLanded: number;
      /** What to say to the user, in one sentence. */
      message: string;
    }
  | {
      /** A book already claims this project. Nothing was adopted again. */
      outcome: 'already-mapped';
      projectId: string;
      bookDir: string;
      key: string;
      exportsLanded: number;
      message: string;
    }
  | {
      /** Nothing was changed anywhere, and this sentence says why. */
      outcome: 'refused';
      reason: string;
    };

/** What `listAdoptableFoundryProjects` answers. */
export interface AdoptableListing {
  projects: AdoptableFoundryProject[];
  /**
   * Folders that were passed over and why, one sentence each. NOT an error and
   * NOT hidden: a user who expected to see their project here needs the reason,
   * and a folder that is not a project is a perfectly ordinary thing to find in
   * somebody's library.
   */
  refusals: string[];
}
