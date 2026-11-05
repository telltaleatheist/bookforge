/**
 * position-sync.model — a shown picture and a position move.
 */
import { Injectable } from '@angular/core';
import { type PositionView } from '@owen/foundry-core/shared/ledger';
import { LedgerService } from './ledger.service';

/**
 * THE LEDGER AND THE VIEWER, KEPT SAYING THE SAME THING.
 *
 * ── One selection, and this is the machinery under it ───────────────────────
 *
 * The app had two selectors pretending to be one. The library selected a FILE,
 * the ledger selected a STEP, and the actions keyed off a mixture — so the user's
 * own report: *"i could have a document open, the epub, but have the pdf import
 * step selected, and id never know that i just ran translate against the original
 * pdf rather than the generated epub because i had the wrong step selected, since
 * the right document was open."* docs/WORKBENCH.md §6c is the ruling; this file
 * is the whole of the mechanism, in both directions.
 *
 * DOWNWARD (the position decides what is shown): three effects and the chain
 * under `showPosition`. A pointer move, a project met for the first time, or a
 * document that changed under a position that did not move — each ends with the
 * viewer holding what the ledger says it should.
 *
 * UPWARD (looking at a document stands on it): `standForTab`, the focus mirror,
 * called by the gestures that put a document in front of somebody.
 *
 * ── Why it is a service, and why nothing depends on it ──────────────────────
 *
 * It came out of `TabsService` with unit 8c (docs/PLAN.md §4) and it is the top
 * of the chain: Notice ← Documents ← Stage ← **PositionSync**. It reads the
 * ledger and the catalogue, it asks the documents service to make and move tabs,
 * and it asks the stage to show them. NOTHING READS IT BACK except the two
 * surfaces that ask `documentShownFor` — the dialogs, which want the position's
 * document rather than whatever tab happens to be up.
 *
 * IT IS ALL EFFECTS, WHICH MEANS IT MUST BE INJECTED TO EXIST. An
 * `@Injectable` nobody injects is never constructed, and three effects that never
 * register are three promises this app makes and silently stops keeping. `App`
 * injects it for exactly that reason and for no other — see the note there.
 */

/**
 * The picture one project is showing in the viewer, and the string that decides
 * whether it has moved.
 *
 * BOTH TOGETHER, never one without the other. The view is what a repaint acts on
 * and the string is what a repaint is decided by, and they are made in one call
 * (`pictureIn`) so that no surface can compare by one answer and act on another.
 */
export interface ShownPicture {
  view: PositionView;
  picture: string;
}

/** One project whose position has moved since this window last painted it. */
export interface PositionMove {
  /** The project directory, folded — the key `showing` is kept under. */
  key: string;
  /**
   * The same directory AS MAIN SPELLS IT, kept beside the folded key.
   *
   * The key is folded because on Windows one path arrives spelled three ways and
   * two spellings of one project would be two entries. What must NOT be folded is
   * what goes back over IPC: main proves the directory is one of Home's projects
   * before it reads a byte, and a lowercased path is a project on this filesystem
   * and a stranger to a string comparison. (`LedgerService.Holding` keeps both for
   * the identical reason.)
   */
  dir: string;
  /** What the viewer was showing, or null for a project this window has just met. */
  was: ShownPicture | null;
  now: ShownPicture;
}
