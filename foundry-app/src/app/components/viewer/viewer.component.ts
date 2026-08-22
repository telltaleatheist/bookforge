import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { CaptureViewComponent } from '../capture-view/capture-view.component';
import { BookViewComponent } from '../book-view/book-view.component';
import { PdfViewComponent } from '../pdf-view/pdf-view.component';
import type { Tab } from '../../core/documents.service';

/**
 * Whatever the tab holds, filling its pane.
 *
 * THE TAB ARRIVES AS AN INPUT rather than being read off the service, and that
 * is what makes panes possible at all: there are up to five of these on screen
 * and only one of them is showing "the active tab". A viewer that asked the
 * service which document to show would show the same one five times.
 *
 * A PDF USED TO RENDER IN CHROMIUM'S OWN VIEWER — an <iframe> at a
 * `foundry-file://` URL served as `application/pdf` — which bought the whole
 * toolbar for no code and was, for as long as it lasted, the thing a custom
 * pdf.js renderer would have to beat before it was worth writing. Two needs
 * beat it, and both are about this app in particular rather than about taste:
 *
 *   THE THUMBNAIL RAIL. Chromium's sits on the left, takes a column of a window
 *   whose entire job is showing a page, and cannot be moved, restyled, narrowed
 *   or turned off from outside the plugin — there is no API and no setting. The
 *   strip in app-pdf-view runs along the bottom and starts hidden.
 *
 *   THE TEXT LAYER. What a PDF DRAWS and what it would give a search are two
 *   different things, and Chromium's viewer only ever shows the first. A
 *   conversion whose words are right and whose reading order is wrong looks
 *   perfect on the page and copies out as nonsense, and the only way to tell was
 *   to search and guess at what a miss meant. app-pdf-view can show the text
 *   beside the page.
 *
 * THE OTHER KIND IS NOT A FILE AT ALL, and it is the surface everything else in
 * this app now leads to: a `book` tab is the project's reflowed blocks drawn on
 * a proof sheet (app-book-view, docs/RENDERER.md §5), which is what a read, a
 * save, an edit and an imported EPUB's origin row all open. It is not deferred
 * like the PDF engine because there is no chunk to defer — it is this app's own
 * components over rows that arrive on an IPC call.
 *
 * A THIRD KIND THAT WAS NOT A FILE EITHER stood here for two days:
 * `app-pages-view`, a captured book's PAGES — the folder of rectified images a
 * mint wrote, scrolled like a PDF because that is what the person asked for and
 * there was no PDF to give them. There is one now (Owen's later ruling,
 * `recordMint`, electron/projects.ts), so a captured book arrives at the PDF
 * branch with every other scan and the kind is retired. The LIGHT TABLE stays:
 * one project has a table of photographs AND, once it has been minted, a book
 * made from them.
 *
 * THE KINDS THAT WENT ARE NOT COMING BACK. `app-epub-view` rendered an unpacked
 * book in a sandboxed <iframe> and `app-html-editor` showed one of its chapters
 * as text beside it; both are deleted with the editing world they belonged to
 * (docs/RENDERER.md §7). What is drawn here is a document this app SHOWS, the
 * book it EDITS, or the light table a capture project arranges.
 *
 * The empty state is Home's job now, not this component's: this only ever runs
 * with a tab, and a viewer with nothing in it is a screen the workspace does not
 * render.
 */
@Component({
  selector: 'app-viewer',
  imports: [BookViewComponent, CaptureViewComponent, PdfViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (tab().kind === 'book') {
      <app-book-view [tab]="tab()" />
    } @else if (tab().kind === 'capture') {
      <!--
        NOT DEFERRED, unlike the PDF branch below. That defer exists because
        pdf.js is half a bundle nobody on Home has asked for; the light table is
        two small components and a WebGL context created on demand, and a
        placeholder frame between clicking a project and seeing its photographs
        would be a cost with nothing bought.
      -->
      <app-capture-view [tab]="tab()" />
    } @else {
      <!--
        A THIRD BRANCH STOOD HERE (Wave 41's gravestone) drawing
        \`app-pages-view\`: the book a mint made, as pictures, because a mint
        wrote rectified page images and no container. The mint assembles the PDF
        now (Owen's later ruling, \`recordMint\`), so a minted book arrives at
        the branch below and pdf.js draws it — which is the surface that brief
        asked for in the first place.
      -->
      <!--
        @defer, so pdf.js is its own chunk rather than half of the bundle the
        window boots with. The first screen of this app is Home, which has no
        document on it at all; loading a PDF engine to show a list of recent
        files is work done before anybody asked for it. "on immediate" means
        the fetch starts the moment a PDF tab exists — it is a file beside
        index.html, so the placeholder is a frame or two. Every pane defers
        the same chunk, which is fetched once and instantiated per pane.
      -->
      @defer (on immediate) {
        <app-pdf-view [tab]="tab()" />
      } @placeholder {
        <div class="waiting"></div>
      }
    }
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; background: var(--bg-sunken); }
    /*
     * NO \`display\` ON THE CHILDREN, and the absence is a lesson paid for. A
     * parent's element rule compiles at higher specificity than the child's own
     * \`:host\`, so the \`display: block\` that used to sit here silently overrode
     * app-book-view's \`display: flex\` — the column that holds the register row
     * above the scrolling pair never engaged, the bench grew to the height of
     * the whole book, and the workspace clipped it: a book nobody could scroll
     * (user report, 2026-08-17). Each viewer declares its own display on its
     * own \`:host\`, where nothing outguns it; this rule only sizes the box.
     */
    app-book-view, app-pdf-view { width: 100%; height: 100%; }
    .waiting { width: 100%; height: 100%; background: var(--bg-sunken); }
  `],
})
export class ViewerComponent {
  readonly tab = input.required<Tab>();
}
