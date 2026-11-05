/**
 * app.drop — files dropped on the window: the veil, and sorting what arrived.
 */
import { isPdfName } from '@owen/foundry-core/shared/capture';
import { CaptureService } from './core/capture.service';
import { IntakeWorkspaceService, isWorkspaceImage } from './core/intake-workspace.service';
import { carriesFiles } from './app.model';
import type { App } from './app';

/**
 * A FILE drag, and only a file drag.
 *
 * A row dragged inside the library — the loose files' reorder — uses the same
 * platform mechanism, and without this test the veil ("Drop a PDF to open it")
 * would slap itself over the whole window the moment one was picked up.
 * `types` is the only part of a drag payload readable before the drop, which
 * is exactly what it is for.
 */
export function onDragEnter(this: App, event: DragEvent): void {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  this.dragDepth += 1;
  this.dropping.set(true);
}

export function onDragOver(this: App, event: DragEvent): void {
  if (!carriesFiles(event)) return;
  // Without this the browser navigates the window to the dropped file, which
  // replaces the whole app with a PDF and no way back.
  event.preventDefault();
}

export function onDragLeave(this: App, event: DragEvent): void {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  this.dragDepth = Math.max(0, this.dragDepth - 1);
  if (this.dragDepth === 0) this.dropping.set(false);
}

export function onDrop(this: App, event: DragEvent): void {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  this.dragDepth = 0;
  this.dropping.set(false);
  const files = Array.from(event.dataTransfer?.files ?? []);

  const front = this.intaking();
  if (front !== null) {
    // One call with every file: intake copies, hashes and decodes them as a
    // batch and answers once with what it did and would not do. Handing them
    // over one at a time would be a recipe write per photograph and a notice
    // bar that overwrites itself twenty-six times.
    void this.captures.intake(front.path, files);
    return;
  }

  /*
   * ── THE MIXED DROP, SORTED BY WHAT THE FILE IS ───────────────────────────
   *
   * Owen (2026-08-22): *"the drop zone on the home page - lets have it accept
   * images (HEIC, PNG, JPG, etc) as input, not just PDF. if the user
   * drag/drops images into the home screen, it pulls them all up in the
   * organizer"*. A drop is not one kind of thing — somebody selecting a
   * folder's worth of a book can easily hand over a PDF and forty
   * photographs in one gesture — so the files are SORTED rather than the drop
   * being classified. A PDF or an EPUB goes through the document door it has
   * always gone through, one tab each; an image goes to the intake workspace,
   * all of them together, because a pile is what the workspace is for.
   *
   * ── WHY THE SEAM IS HERE AND NOT ON HOME'S RECTANGLE ─────────────────────
   *
   * Home HAS a drop target and it is decorative in the strict sense — the
   * whole window takes the drop, and the rectangle exists so that anybody
   * knows that (HomeComponent's docblock, and this class's). Hanging the
   * workspace off that element would rebuild the exact failure the capture
   * front-tab routing was written to fix: a strip down one side of the light
   * table, with every drop that missed it falling through to the document
   * admission and coming back as "IMG_0238.HEIC is not something Foundry
   * opens". A person dropping photographs at this app is not aiming at a
   * rectangle either.
   *
   * ── AND IT IS NOT GATED ON HOME BEING ON SCREEN ──────────────────────────
   *
   * The workspace lives in the library sidebar, which is permanent chrome on
   * every route. So the rule is about the FILE, not about what is in front of
   * it: an image is never a document this app can open, and with no capture
   * project in front there is exactly one useful thing to do with one. Gating
   * on the route would mean the same gesture, one second apart, either
   * organised a shoot or raised a refusal — and the refusal is what it used
   * to raise, which is what Owen was ending.
   *
   * HOSTED, THERE IS NO WORKSPACE and images fall through to the document
   * door as they always did: `available` is the one place that decides it
   * (`IntakeWorkspaceService`), for the reason "Photograph a book…" is behind
   * the same guard — a project born here would land in a library the host is
   * not keeping.
   */
  const images = this.shelf.available() ? files.filter(isWorkspaceImage) : [];
  /*
   * ── AND A PDF NOW MEANS TWO THINGS, SO THE DROP IS ASKED ABOUT ───────────
   *
   * Owen, 2026-09-10: *"give me the ability to drag/drop a pdf into a new
   * book, not just images. if i do, it should take each page as an individual
   * image. theres a book that is just a bunch of scanned images that need to
   * be cropped and split and stuff"*.
   *
   * An image has exactly one useful meaning here and is sorted silently, one
   * paragraph down. A PDF has TWO, and both are things this app does for a
   * living: it is a book to OPEN — the gesture this window has had since the
   * first day and the one most drops mean — or it is a bound stack of
   * photographs to TAKE APART onto the light table. Nothing about the file
   * says which; the same scan is both, on different evenings.
   *
   * SO IT IS ASKED RATHER THAN GUESSED, and asked ONCE for the whole drop
   * rather than once per file — somebody handing over four scans at a time
   * means the same thing by all four, and four stacked cards would be this app
   * making them say it four times. The card is deferred to `sortPdfs` because
   * it is a round trip and this handler must not become async: the files list
   * off a `DragEvent` does not survive an await.
   *
   * A LIGHT TABLE IN FRONT NEEDS NO CARD AT ALL and never reaches here — the
   * intake door above takes the whole drop, and a PDF dropped on a table of
   * page cards has only ever had one meaning (`CaptureService.intake`).
   *
   * HOSTED, THERE IS NO WORKSPACE AND SO NO SECOND MEANING. `available` is the
   * one place that decides it, for the reason images fall through there too: a
   * project born in a hosted window would land in a library the host is not
   * keeping.
   */
  const pdfs = this.shelf.available() ? files.filter((file) => isPdfName(file.name)) : [];
  if (pdfs.length > 0) void this.sortPdfs(pdfs);

  if (images.length > 0) {
    this.shelf.take(images);
    /*
     * AND THE PANEL IS OPENED, because the workspace is IN it. A drop that
     * landed behind a collapsed 30-pixel stub is a drop that vanished — the
     * toast would say twenty images arrived and the window would show no sign
     * of one. This is the shell's business rather than the service's: the
     * service holds the images, the shell holds the furniture they are drawn
     * in, and a service reaching out to un-collapse a panel would be the
     * wrong half of the app deciding what is on screen.
     */
    this.ui.documentsShown.set(true);
  }

  // Every file, not just the first: a drop of three books is three tabs, which
  // is the whole reason there are tabs.
  for (const file of files) {
    // A PDF's tab is opened by `sortPdfs` if that is what the person says they
    // meant. Opening it here as well would put the book on screen before the
    // card asking whether they wanted it there had been answered.
    if (images.includes(file) || pdfs.includes(file)) continue;
    void this.documents.openDropped(file);
  }
}

/**
 * Ask what the dropped PDFs are, and do it.
 *
 * ── THE DISMISSAL DOES NOTHING, DELIBERATELY ────────────────────────────────
 *
 * Escape, the scrim, or another dialog opening over this one answers `nothing`
 * — no tab, no pages, no toast. The alternative considered was to fall back to
 * opening, on the grounds that it is what the window did before this card
 * existed and it is cheap to undo. It is out because a dismissal is a person
 * saying "not this", and answering it with an action is the card overruling
 * them; the gesture is a drag away from being repeated, and the file is still
 * wherever they dragged it from.
 *
 * ── THE PAGES ARE READ ONE PDF AT A TIME ────────────────────────────────────
 *
 * Sequentially, not in parallel: each explosion holds a canvas the size of a
 * page and a pdf.js worker, and two at once would double both to finish no
 * sooner — the work is the rasterizing, and it is already using the machine.
 * It also keeps the progress card telling one true story rather than two
 * interleaved ones.
 *
 * ── THE TWO BUTTONS ARE NAMED FOR THE PERSON WHO DID NOT BUILD THIS ────────
 *
 * They said *Open it* and *Make a book from its pages*, and Owen retired both
 * (2026-09-21): *"maybe we can rename those buttons to make sense for somebody
 * who doesnt know what theyre for exactly. maybe it can just be 'edit book' or
 * 'open book'. that might be more logical."* — and the sentence he gave for why
 * is the whole ruling: *"that makes sense to me because i know what i
 * programmed it to do."*
 *
 * "Make a book from its pages" describes the MACHINERY — an explosion, a light
 * table, a selection, a mint — to somebody who has not met any of it. *Edit
 * book* describes the OUTCOME, which is the only thing they can have an opinion
 * about; that it happens by taking the book apart is what the detail paragraphs
 * are for, and they now say it in words nobody has to already know.
 *
 * THE PAIR IS DELIBERATELY SYMMETRICAL — *Open book* / *Edit book*, one verb
 * apart — because the question this card asks is which of two things the person
 * means, and two labels of different shapes read as two unrelated offers. The
 * same two words name the door inside an open book (`ActionMenuComponent`'s
 * *Edit book*, which does exactly this to a project's own PDF), and that is not
 * a coincidence to be tidied away: one gesture with one name, wherever it is
 * reached from.
 */
export async function sortPdfs(this: App, pdfs: readonly File[]): Promise<void> {
  const one = pdfs.length === 1;
  const answer = await this.confirm.put({
    title: one ? pdfs[0]!.name : `${pdfs.length} PDFs`,
    message: one
      ? 'What is this?'
      : 'What are these?',
    detail: [
      one
        ? 'Open book reads it exactly as it is: the pages go through Foundry the ordinary way, '
          + 'and everything after that is made from what they say.'
        : 'Open books reads them exactly as they are: the pages go through Foundry the ordinary '
          + 'way, and everything after that is made from what they say.',
      one
        ? 'Edit book takes it apart first, into one picture per page, so you can crop them, '
          + 'split a two-page spread into two pages, and turn a page the right way up. The book '
          + 'is rebuilt out of the pages you fixed, and read from there.'
        : 'Edit books takes them apart first, into one picture per page, so you can crop them, '
          + 'split a two-page spread into two pages, and turn a page the right way up. Each book '
          + 'is rebuilt out of the pages you fixed, and read from there.',
      'Pages land in the workspace, where you choose which of them become a book.',
    ],
    choices: [
      { key: 'open', label: one ? 'Open book' : 'Open books' },
      { key: 'pages', label: one ? 'Edit book' : 'Edit books' },
    ],
    preferred: 'open',
    dismissed: 'nothing',
    checkbox: null,
  });

  if (answer.key === 'open') {
    for (const file of pdfs) void this.documents.openDropped(file);
    return;
  }
  if (answer.key !== 'pages') return;

  /*
   * THE PANEL IS OPENED BEFORE THE FIRST PAGE IS DRAWN, not after the last.
   * The workspace lives inside it, and the reason is the one written where
   * images do the same: a drop that landed behind a collapsed 30-pixel stub is
   * a drop that vanished. Here it matters more, because the rasterizing takes
   * minutes and the person should be able to watch the cards arrive.
   */
  this.ui.documentsShown.set(true);
  for (const file of pdfs) {
    const exploded = await this.pdfPages.explode(file, true);
    if (exploded !== null) {
      this.shelf.takePages(exploded);
      continue;
    }
    /*
     * A NULL IS TWO DIFFERENT THINGS AND THEY ARE ANSWERED DIFFERENTLY. A scan
     * that would not open is no reason to lose the three beside it, so the
     * loop goes on. STOP MEANT ALL OF THEM — somebody who pressed it once and
     * then watched the next PDF start would be pressing it four times to end
     * one gesture.
     */
    if (this.pdfPages.stopped()) return;
  }
}
