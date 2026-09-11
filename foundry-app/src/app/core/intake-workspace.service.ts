import { Injectable, computed, inject, signal } from '@angular/core';

import { isPhotographName } from '@shared/capture';

import { api, hosted } from './foundry';
import { CaptureService } from './capture.service';
import { OpenDocumentsService } from './documents.service';
import { NoticeService } from './notice.service';
import type { StagedPdf } from './pdf-pages.service';

/**
 * THE INTAKE WORKSPACE — the table photographs land on before anybody has said
 * which book they are.
 *
 * ── Owen's ruling, 2026-08-22, verbatim ─────────────────────────────────────
 *
 * *"lets remove the 'OCR...' button from the homepage. and the drop zone on the
 * home page - lets have it accept images (HEIC, PNG, JPG, etc) as input, not
 * just PDF. if the user drag/drops images into the home screen, it pulls them
 * all up in the organizer and they can select one or more, right-click them,
 * and select 'create new book' from them. itll pop up a modal to name the new
 * book and open in the project just as though they had started a new book from
 * the home page. im thinking we can put the tree workflows in accordions just
 * like the inspector chapter/notes/furniture accordions. each book opened will
 * be an accordion with an X next to it to close, or an arrow to minimize it.
 * the working area where theyre defining what's a book and what isn't can be
 * labeled 'workspace' or something until theyve finished defining the pages as
 * new books. then they close the workspace and whatever wasnt assigned to a new
 * library/book is cleared away. if they want to pull it up again theyll have to
 * re-upload the images. but theyll be saved in the new books they added. the
 * pages are moved out of the workspace and into the new project they create
 * when they click create new project or whatever."*
 *
 * ── WHY IT IS NOT CALLED `WorkspaceService` ─────────────────────────────────
 *
 * Because `WorkspaceComponent` already exists and is the app's main ROUTE — the
 * surface a book is read on. Owen's word for this thing is "workspace" and the
 * accordion in the sidebar says exactly that, because that is the word he used
 * and the user's word wins on the surface. In the code the two must not share a
 * name, or the day somebody greps for the workspace they get a page and a pile
 * of photographs and no way to tell which file they are in.
 *
 * ── THE LIFECYCLE IS THE SEMANTICS, NOT A LIMITATION ────────────────────────
 *
 * Nothing here touches the disk. The list is a signal in this renderer, the
 * pictures are `URL.createObjectURL` handles over the dropped `File` objects,
 * and both die with the window — which is exactly what Owen described: close
 * the workspace and what was never assigned is gone, and the way back is to
 * drag the images in again. A cache on disk would be a second copy of somebody's
 * photo library that this app would then have to be trusted to clean up, in
 * service of a state whose whole point is that it is temporary.
 *
 * WHAT IS PERMANENT IS WHAT WAS ASSIGNED. `createBook` copies the chosen images
 * into a real capture project through the real intake — the same door the light
 * table's own drop uses — so the moment a book is made, those photographs are on
 * disk in that project's `capture/originals/` and this list's copy of them is
 * nothing but a thumbnail waiting to be revoked.
 *
 * ── EACH ITEM HOLDS A PATH *AND* A URL, AND NEITHER SUBSTITUTES ─────────────
 *
 * The URL draws the thumbnail; only the browser can make one, and only from the
 * `File`. The PATH is what `capture:intake` needs; only the preload can make one
 * (`webUtils.getPathForFile`), and this side takes it AT DROP TIME because that
 * is the moment the drag's own data is guaranteed live. Holding one and deriving
 * the other later is how a workspace ends up with a grid full of pictures and
 * nothing it can hand to main.
 *
 * ── STANDALONE ONLY, DECIDED IN ONE PLACE ───────────────────────────────────
 *
 * `available` is that place. Hosted, this app has no Home, no capture door and
 * no library of its own — a project born in a hosted window would land in a
 * library that is not keeping it (the same argument that put "Photograph a
 * book…" behind the hosted guard). So hosted, images dropped on the window go on
 * meeting the document door and being refused by name, exactly as they did
 * before this file existed.
 */
@Injectable({ providedIn: 'root' })
export class IntakeWorkspaceService {
  private readonly captures = inject(CaptureService);
  private readonly documents = inject(OpenDocumentsService);
  private readonly notices = inject(NoticeService);

  /**
   * The unassigned images, in the order they were dropped.
   *
   * DROP ORDER AND NOT A SORT. The light table has two sort keys and an
   * argument about which one a screenshot shoot wants (`CaptureService.sortBy`);
   * this is upstream of all of that. Here the person is only saying which pile
   * is which book, and re-ordering their pile under them while they are picking
   * from it would move the cards they are pointing at.
   */
  readonly items = signal<readonly WorkspaceImage[]>([]);

  /**
   * The PDF staging directories this table is keeping alive.
   *
   * NOT DERIVED FROM `items`, because the question it answers is "what did we
   * ask main to hold open", and the answer has to survive the moment the last
   * card referencing a stage is removed — that is precisely when the stage must
   * be released, and an id read off the list at that point is already gone. See
   * `sweep`.
   */
  private readonly staged = new Set<string>();

  readonly count = computed(() => this.items().length);
  readonly holding = computed(() => this.items().length > 0);

  /** Whether this app has a workspace at all — see the header. */
  readonly available = computed(() => !hosted());

  /**
   * Take a drop.
   *
   * ONE PATH PER FILE, TAKEN NOW. A file the browser will not give a path for
   * is refused HERE rather than kept as a card that would fail at create time:
   * a picture on the table that cannot become a page is a promise this surface
   * would be breaking later, in front of somebody who had already named a book.
   * That happens for a drag out of another application's virtual folder, and it
   * is counted rather than named — the one sentence at the end says how many,
   * which is `CaptureService.intake`'s own rule for the same failure.
   *
   * DEDUPLICATED BY PATH, because dropping the same folder twice is a thing
   * people do and two cards over one file would become one photograph at intake
   * (main is content-addressed) and a card left behind pointing at nothing. The
   * fold is the whole path lowercased, never a basename: two folders of scans
   * both holding `page-001.png` are two different photographs and this table has
   * no business merging them.
   */
  take(files: readonly File[]): void {
    if (api === null || !this.available()) return;
    const already = new Set(this.items().map((item) => fold(item.path)));
    const arrived: WorkspaceImage[] = [];
    let unreadable = 0;
    let repeated = 0;
    for (const file of files) {
      const path = api.pathForFile(file);
      if (path === '') {
        unreadable += 1;
        continue;
      }
      const key = fold(path);
      if (already.has(key)) {
        repeated += 1;
        continue;
      }
      already.add(key);
      arrived.push({
        id: key,
        name: file.name,
        path,
        url: URL.createObjectURL(file),
        // A file the person dragged from their own disk. Nothing here may ever
        // delete it — see `WorkspaceImage.stage`.
        stage: null,
      });
    }
    if (arrived.length > 0) this.items.update((held) => [...held, ...arrived]);

    const said: string[] = [];
    if (arrived.length > 0) {
      said.push(
        arrived.length === 1
          ? 'One image is in the workspace. Select it and right-click to make a book from it.'
          : `${arrived.length} images are in the workspace. Select some and right-click to make a book from them.`,
      );
    }
    if (repeated > 0) {
      said.push(`${repeated} ${repeated === 1 ? 'was' : 'were'} already here.`);
    }
    if (unreadable > 0) {
      said.push(
        `${unreadable} could not be read from where ${unreadable === 1 ? 'it was' : 'they were'} dragged from.`,
      );
    }
    if (said.length > 0) this.notices.notice.set(said.join(' '));
  }

  /**
   * Take the pages of a PDF somebody exploded onto this table.
   *
   * ── WHY IT IS A SECOND DOOR AND NOT `take` WITH A FLAG ─────────────────────
   *
   * `take` above is handed browser `File` objects and does two things with each:
   * asks the preload for its path, and makes a thumbnail URL from its bytes.
   * Neither applies here. The pages are ALREADY on disk — main staged them, and
   * the path it answered with is the only one there is — and their thumbnails
   * were made from the canvas they were drawn on, at a size that can be held in
   * memory (`PdfPagesService`, which argues both). Routing them through `take`
   * would mean fabricating `File` objects in order to derive facts we were just
   * handed, which is the mistake `intakePaths` was split out to stop.
   *
   * DEDUPLICATED BY PATH LIKE EVERYTHING ELSE HERE, which for staged pages is
   * belt and braces — a staging directory is fresh per explosion, so two of its
   * pages cannot collide — but it is the same fold as the drop door and there is
   * no case for a second rule. Dropping the SAME PDF twice therefore does land
   * two sets of cards, correctly: they are two staging directories, and the
   * person will get one book out of whichever set they select. Intake is
   * content-addressed, so a book made from both would hold each page once.
   */
  takePages(exploded: StagedPdf): void {
    if (api === null || !this.available()) return;
    const already = new Set(this.items().map((item) => fold(item.path)));
    const arrived: WorkspaceImage[] = [];
    for (const page of exploded.pages) {
      const key = fold(page.path);
      if (already.has(key)) continue;
      already.add(key);
      arrived.push({
        id: key,
        name: page.name,
        path: page.path,
        // Empty rather than null: this table's cards draw an `img` off it, and
        // a page whose thumbnail failed to encode is better as a blank card
        // than as a missing one. `explode` only ever hands back a null url for
        // the door that draws no cards at all, which is not this one.
        url: page.url ?? '',
        stage: exploded.stageId,
      });
    }
    if (arrived.length > 0) {
      this.staged.add(exploded.stageId);
      this.items.update((held) => [...held, ...arrived]);
    } else {
      // Nothing landed, so nothing is holding the staging open. Released here
      // rather than left to `sweep`, which only ever looks at stages this table
      // took responsibility for.
      void api.capture.pdfStageRelease(exploded.stageId).catch(() => undefined);
    }

    const said: string[] = [];
    if (arrived.length > 0) {
      said.push(
        arrived.length === 1
          ? `One page came out of ${exploded.stem}. Select it and right-click to make a book from it.`
          : `${arrived.length} pages came out of ${exploded.stem}. `
            + 'Select some and right-click to make a book from them.',
      );
    }
    if (exploded.refused.length > 0) {
      // NAMED AND COUNTED, never swallowed: a book quietly short a leaf is the
      // failure this app refuses to ship, and the page numbers are in the names.
      said.push(
        `${exploded.refused.length} would not draw `
        + `(${exploded.refused.map((each) => each.file).join(', ')}).`,
      );
    }
    if (said.length > 0) this.notices.notice.set(said.join(' '));
  }

  /**
   * Make a book out of some of them — the two existing doors, in sequence.
   *
   * ── IT IS NOT NEW MACHINERY AND MUST NOT BECOME ANY ─────────────────────────
   *
   * `capture:create` already makes a named, empty capture project and answers
   * with the directory that is the only handle on it. `capture:intake` already
   * copies files into one, hashes them, decodes them, and answers with what it
   * would not do. "Create a new book from these nine images" is those two
   * sentences said one after the other, and this method is the word "then".
   * Everything a person sees afterwards — the light table, the recipe, the
   * refusals in a toast — is the machinery that was already there.
   *
   * ── WHAT HAPPENS WHEN THE SECOND DOOR REFUSES SOME OF IT ───────────────────
   *
   * The intake's own report goes to the notice, as it does for every other drop
   * in this app: how many landed, which were duplicates, and the reason for each
   * refusal in main's words. This method does not re-say any of it.
   *
   * WHAT IT DECIDES IS THE LIST, and the rule is: an intake that RAN empties the
   * selection out of the workspace, refusals included. Not because a refused
   * photograph does not matter, but because the only handle this side would have
   * to keep it by is main's `refused[].file` — a BASENAME — and matching a
   * basename back onto a table that may hold `page-001.png` from two different
   * folders is precisely the fold this app forbids everywhere else. A wrong
   * match here would leave the wrong picture behind and take the right one away,
   * silently. So the honest rule is the coarse one: what you assigned is
   * assigned, what main would not read is named in the toast, and a photograph
   * that has to come back comes back the way everything in a session-only
   * workspace comes back — by being dragged in again.
   *
   * AN INTAKE THAT DID NOT RUN AT ALL CHANGES NOTHING. `null` from the intake is
   * "main never got to it", and emptying a list on the strength of that would
   * destroy the only copy of somebody's selection over a failure they can see on
   * screen. The project is still opened in that case: it was named, it exists,
   * and its light table is the surface the images can be dragged onto directly.
   */
  async createBook(title: string, ids: readonly string[]): Promise<boolean> {
    if (!this.available()) return false;
    const wanted = new Set(ids);
    const chosen = this.items().filter((item) => wanted.has(item.id));
    if (chosen.length === 0) return false;

    const dir = await this.captures.create(title);
    // The service has already put its own sentence on the notice strip. A
    // second one here would be this file's guess at what main said.
    if (dir === null) return false;

    const report = await this.captures.intakePaths(dir, chosen.map((item) => item.path), 0);
    /*
     * THE TAB IS OPENED THE WAY "Photograph a book…" OPENS ONE — from the
     * DIRECTORY, because a capture project has no file for main to be asked
     * permission about, and with no navigation, because Home is the workspace
     * route with nothing up and showing the tab is what puts the light table on
     * screen. Identical to `CaptureNewDialogComponent.create`, deliberately:
     * Owen asked for a book that opens "just as though they had started a new
     * book from the home page", and the way to keep that true is to do the same
     * thing rather than something equivalent.
     */
    this.documents.show(this.documents.captureTabIn(dir));
    if (report !== null) this.release(ids);
    return true;
  }

  /** Let some of them go — the thumbnails' URLs, and any emptied staging, with them. */
  release(ids: readonly string[]): void {
    const going = new Set(ids);
    let left: readonly WorkspaceImage[] = [];
    this.items.update((held) => {
      for (const item of held) if (going.has(item.id)) URL.revokeObjectURL(item.url);
      left = held.filter((item) => !going.has(item.id));
      return left;
    });
    this.sweep(left);
  }

  /**
   * Close the workspace: everything unassigned goes.
   *
   * REVOKED, NOT JUST DROPPED. An object URL is a reference the document holds
   * onto the file's bytes until it is revoked or the page goes away, so a
   * workspace opened and cleared four times in a session would be four shoots'
   * worth of pixels pinned in this renderer with nothing on screen drawing them.
   * The list is the only thing that knows the handles exist.
   *
   * THE QUESTION IS ASKED BY THE SURFACE, NOT HERE. This is the act; whether to
   * warn about it is a fact about how many are left and belongs where the count
   * is drawn (`OpenDocumentsComponent`), beside the app's one confirmation card.
   */
  clear(): void {
    for (const item of this.items()) URL.revokeObjectURL(item.url);
    this.items.set([]);
    this.sweep([]);
  }

  /**
   * Delete the staging directory of any exploded PDF nothing is pointing at.
   *
   * ── THE ONLY FILES THIS SERVICE IS ALLOWED TO DELETE ────────────────────────
   *
   * A dropped photograph's path is the person's own file, sitting where they
   * dragged it from, and this table would sooner leak than touch it — which is
   * why the permission is carried per item (`WorkspaceImage.stage`) rather than
   * inferred from anything about the path. A staged page's path is a copy main
   * made for the sole purpose of being handed to intake; once no card names it,
   * it is a scan's worth of PNGs in %TEMP% that nothing will ever ask for again.
   *
   * COMPUTED FROM WHAT IS LEFT, not from what went. Two cards of one PDF removed
   * one at a time must not free the staging under the other one, and the honest
   * way to say that is to look at the survivors. `left` is passed in rather than
   * read back off the signal because both callers have just written it, and a
   * re-read is a chance for the two to be a beat apart.
   *
   * BEST EFFORT AND UNAWAITED. A directory that will not delete is wasted space
   * in a place the OS already treats as disposable, and main sweeps every
   * staging it is not holding open before it makes the next one
   * (`pdfStageBegin`). Nothing on screen depends on this having happened.
   */
  private sweep(left: readonly WorkspaceImage[]): void {
    if (api === null) return;
    const bridge = api;
    const kept = new Set(left.map((item) => item.stage).filter((stage) => stage !== null));
    for (const stage of this.staged) {
      if (kept.has(stage)) continue;
      this.staged.delete(stage);
      void bridge.capture.pdfStageRelease(stage).catch(() => undefined);
    }
  }
}

/**
 * ONE IMAGE ON THE TABLE, BEFORE IT IS A PAGE OF ANYTHING.
 *
 * There is no capture vocabulary in here on purpose — no quad, no split, no
 * order. Those are the light table's words and they only mean anything once a
 * photograph belongs to a book. Here it is a name, a picture and a path, which
 * is everything "is this one of them?" needs and nothing more.
 */
export interface WorkspaceImage {
  /** The folded path — stable, unique on this table, and its own dedupe key. */
  id: string;
  /**
   * The dropped file's own name.
   *
   * THE ONE FILENAME THIS APP PRINTS, and it is printed for the reason capture
   * intake prints one: the person is looking at their own photographs and the
   * name on the card is the name they gave it, or their camera did. Everywhere
   * else a filename in the copy would be this app's bookkeeping leaking out.
   */
  name: string;
  /** Where it is on disk — taken at drop time, handed to `capture:intake`. */
  path: string;
  /** The thumbnail's source. Revoked when this item leaves the table. */
  url: string;
  /**
   * The PDF explosion this page came out of, or null for a file off the disk.
   *
   * A DROPPED PHOTOGRAPH'S `path` IS THE PERSON'S OWN FILE and this table has no
   * business ever deleting it. A page of an exploded PDF's `path` is a copy main
   * made in a staging directory that only exists to be handed to intake — so it
   * has to be swept when the last page of that PDF leaves the table, and this is
   * the only handle anything has on it. Null is the older, ordinary case, and
   * the difference is exactly "may I delete this file": never, versus once
   * nobody is pointing at it.
   */
  stage: string | null;
}

/** Windows spells one file three ways; the table compares them folded. */
function fold(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

/**
 * Is this dropped file a photograph rather than a document?
 *
 * RE-EXPORTED FROM `shared/capture` RATHER THAN RE-DECIDED. The drop seam in the
 * shell asks this question of every file before it routes anything, and the
 * answer has to be the same set of extensions main will read at intake — see
 * `PHOTOGRAPH_TYPES`, which used to live in the main process precisely because
 * nobody else had an opinion, and moved when this side got one.
 */
export function isWorkspaceImage(file: File): boolean {
  return isPhotographName(file.name);
}
