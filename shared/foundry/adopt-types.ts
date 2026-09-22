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

/**
 * A Foundry project that IS one and cannot be adopted anyway.
 *
 * Kept apart from `AdoptableFoundryProject` rather than folded into it with
 * nullable fields, because the fields that make a project adoptable — the
 * original's kind, its title out of the catalogue — are exactly the ones that
 * could not be read. A row that carried them as `null` would invite every
 * consumer to ask whether this one is real, and one of them would get it wrong.
 */
export interface BlockedFoundryProject {
  /** The project key — the folder's name. All we can be sure of. */
  key: string;
  /** The folder, absolute. Shown on hover so the user can go and look. */
  dir: string;
  /** Which half of the search found it — same meaning as on an adoptable. */
  origin: 'standalone' | 'hosted';
  /**
   * Why it cannot be adopted, in ONE clause and no more.
   *
   * This is tooltip text, not a paragraph: the row itself already says the
   * project cannot be taken, so the reason only has to answer "why not" for
   * somebody who stopped to ask. The long form these were written as is still
   * what `adoptFoundryProject` throws when something presses through anyway.
   */
  reason: string;
  /** When its catalogue was last written, ISO — or null if that could not be read. */
  modifiedAt: string | null;
}

/** What `listAdoptableFoundryProjects` answers. */
export interface AdoptableListing {
  projects: AdoptableFoundryProject[];
  /**
   * Projects that cannot be adopted, to be DRAWN rather than explained: the row
   * is greyed with `reason` on hover. Owen's ruling, 2026-08-22 — *"i dont need
   * an explanation if a book cant be adopted. just show it grayed out with a
   * tooltip maybe"* — after an unadoptable project put a four-line paragraph
   * under the list while the project it was about was nowhere on screen.
   */
  blocked: BlockedFoundryProject[];
  /**
   * What could not even be looked at: a root that would not list. NOT per
   * project — anything about a specific project is a `blocked` row now, because
   * a sentence about a thing you can see beats a sentence about a thing you
   * cannot.
   */
  refusals: string[];
}

/**
 * A standalone Foundry project a book of ours was adopted FROM, if one is still
 * there — what "Reload from Foundry" would read.
 *
 * Carried on the mapping answer rather than asked for separately because the
 * button that needs it is drawn from that same read: a book with a mapping and
 * no standalone counterpart is the ordinary state of a project that was made in
 * the hosted window, and its Reload button is disabled with this as the reason.
 */
export interface FoundryStandaloneSource {
  /** The standalone project folder, absolute. */
  dir: string;
  /** When its catalogue was last written, ISO — the "worked on" date. */
  modifiedAt: string;
}

/**
 * What one press of Reload from Foundry did.
 *
 * FOUR OUTCOMES AND NOT A BOOLEAN, because "nothing came across" has three
 * different meanings and the user pressed the button to learn which. Nothing was
 * there to bring (`current`); something was there and this side declined to take
 * it (`declined`); or the press could not be carried out at all (`refused`).
 */
export type FoundryRefreshResult =
  | {
      /** Nothing was done, and this sentence says why. */
      outcome: 'refused';
      reason: string;
    }
  | {
      /** The copy already matched the original. Exports may still have landed. */
      outcome: 'current';
      message: string;
      exportsLanded: number;
    }
  | {
      /**
       * The hosted copy is NEWER than the standalone original, so it was left
       * alone. A refusal to overwrite work, not a failure.
       */
      outcome: 'declined';
      message: string;
      exportsLanded: number;
    }
  | {
      outcome: 'refreshed';
      message: string;
      /** How many files were written — the "just the files affected" count. */
      filesCopied: number;
      /** How many the original no longer has, and the copy no longer holds. */
      filesRemoved: number;
      exportsLanded: number;
    };

/**
 * WHERE ONE ADOPTION HAS GOT TO — the thing a spinner cannot say.
 *
 * Adopting a Foundry project is one `invoke` that does not answer until the
 * whole of it is done, and the whole of it is: hash a PDF, copy a gigabyte of
 * page images across an SMB share, mint a book, sweep a tray. On a big project
 * that is minutes of a button with a spinner in it, which reads as a hang — it
 * is what Owen hit on Fragebogen (2026-09-22). So the act announces itself as it
 * goes, on `foundry-host:adopt-progress`, and the modal draws a bar.
 *
 * `percent` IS THE WHOLE ADOPTION, not the phase — the bar must not restart at
 * each act — and it is MONOTONIC by construction on main's side: a bar that goes
 * backwards reads as a fault, and the only honest answer to "the census was
 * short" is to stay where we are rather than to retreat.
 */
export interface AdoptProgress {
  /** The project folder being adopted — which row this belongs to. */
  dir: string;
  /** Which act is running. For styling and for tests; the label is what is read. */
  phase: AdoptPhase;
  /** One line for the user: "Copying 412 of 1,208 files". Always a full sentence's worth. */
  label: string;
  /** 0–100 across the whole adoption. */
  percent: number;
}

/**
 * The acts of an adoption, in the order `adoptFoundryProject` performs them.
 * Named for what the user is waiting on, not for the function that does it.
 */
export type AdoptPhase =
  /** Reading the project's catalogue — is this a Foundry project at all. */
  | 'reading'
  /** Asking the library whether a book already claims it. */
  | 'checking'
  /** Copying (or bringing forward) the project under the library. The long one. */
  | 'copying'
  /** Making the book from the project's own archived original. */
  | 'minting'
  /** Recording the mapping between the book and the project. */
  | 'joining'
  /** Landing whatever is already in the project's export tray. */
  | 'exports';
