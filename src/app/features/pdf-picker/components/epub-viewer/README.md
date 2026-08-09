# epub-viewer

The live-DOM EPUB viewer: a book's own pages, in a grid the picker can point at.

The raster viewer (`../pdf-viewer/pdf-viewer.component.ts`) paints SVG rectangles over a bitmap
of a mupdf-laid-out page. This one paints nothing. It mounts the book's real DOM inside sandboxed
frames and puts the picker's marks ON the book's own elements as CSS classes. Both satisfy
`shared/document/laid-out-book.ts` and emit the same gestures, so the picker above them does not
have to know which is mounted.

Phase B of the quire plan. Phase C put it on the picker's open path: `pdf-picker.component.ts`
branches at open — `showsEpubViewer()` — and an EPUB reaches this component while a PDF reaches
the raster one. The bench is still here and still the way to drive it alone:
`/#/epub-viewer-harness?book=<path>` and `tools/epub-viewer-harness.js`.

What the picker hands it: `book` is the PICKER's own `LaidOutBook` (its analysis blocks, which the
user has been editing), not the bridge's — one description of what is in the document. `source` is
`window.electron.quire.openBook`'s mounts. The picker refuses to mount this component at all if the
two disagree about the page count, since every page-keyed gesture would otherwise point one page at
two places.

Two things Phase C added to the component itself:

- **`scrollToPage(page)`**, the one raster-viewer method the parent calls that means something to a
  live book (search results, the page timeline and the outline all navigate by page). Band
  arithmetic rather than `scrollIntoView`, because the target page is usually still a placeholder
  when it is asked for — scrolling there is what causes its frame to mount.
- **`blockDoubleClick` now carries `metaKey`/`ctrlKey`.** The picker reads them: a double-click with
  the modifier held ADDS the like-this run to the selection instead of replacing it. Emitting the
  block alone would have made every double-click on a live book replacing — a quiet behaviour change
  rather than a missing feature.

---

## The host — decided by measurement (2026-08-09)

The plan named two candidates and said to decide with a measurement, not a preference. Reading the
code turned two into four, and running them turned up a fifth question that decided more than the
other four together. Everything below is `tools/probe-quire-host.js` on *Killing America*
(24 spine documents, 1,360 stamped elements, 183 pages at 600×900 px), Electron 29.4.6.

### The verdict

**One `<webview>` per SPINE DOCUMENT, its `.pagedjs_page` boxes arranged into a grid inside the
frame, mounted only while the band is on screen.**

### D — a plain `<iframe>` in the Angular renderer: does not load at all

| | |
|---|---|
| `<iframe src="quire://…">` in the app's own renderer | **no load event within 5,000 ms** |

Not a performance result — a structural one, and it is why the plan's candidate (a) is not on the
table in the form the plan imagined. `quire://` is registered on the DOCUMENT'S session
(`quire-<random>`, non-persistent, created per book in `QuireDocument.open`). The Angular renderer
is on the app's session, which has no quire handler, so the URL resolves to nothing. Making it work
would mean attaching quire's protocol to BookForge's own session — putting a stranger's markup on
the app's origin and giving the book the app's cookies, cache and storage. That is the one line the
plan says must hold in every host, so this candidate fails on the sandbox criterion, not on speed.

A `<webview>` IS the sandboxed-frame-in-the-renderer idea, correctly spelled: it takes a
`partition`, so it is out-of-process, on the book's own session, under quire's CSP — which is
exactly what `packages/quire/src/mount.ts` already builds.

### C — a native-view overlay: one page at a time, and Angular cannot paint on it

| | |
|---|---|
| `WebContentsView` available on Electron 29.4.6 | **no** — that class and `BrowserWindow.contentView` arrived in Electron 30 |
| measured with `BrowserView` (the pre-30 spelling of the same native child view) | |
| first page (load + present) | 180 ms |
| second page in the same view | 83 ms |
| pages visible at once | **1** |
| `setBounds` round trip, p50 / p95 | **33.3 ms / 34.8 ms** — two frames at 60 Hz |
| an Angular overlay can paint over it | **no** |
| teardown | 6 ms |

Fast at showing one page, and disqualified on three counts. A grid of twelve pages needs twelve
native views. Following a scrolling grid means re-sending bounds from the renderer every frame, and
that round trip is 33 ms — the overlay would lag the page it is supposed to be part of by two
frames, permanently. And a native child view is a sibling of the window's web contents, not an
element in it: `document.elementFromPoint` over the view returns the DOM element *underneath*, so
marquee rectangles, hover outlines, page labels and context menus cannot be drawn on top of the
page they belong to. The plan's first criterion was "input routing to Angular overlays". This
fails it outright.

### A vs B — per page, or per spine document?

Both are `<webview>`s. The difference is what one frame holds.

| | A: one frame per PAGE | B: one frame per SPINE DOCUMENT, gridded |
|---|---|---|
| first page on screen | 183 ms | 168 ms |
| a 12-page window | 2,538 ms | **1,116 ms** |
| evaluations of the ~1 MB fragmenter | **12** | **6** (one per document, whatever its page count) |
| median per page | 245 ms | 93 ms |
| arranging the boxes into a grid | — | 2.2 ms |
| frames (renderer processes) for 12 pages | 12 | 6 |
| host DOM nodes | 32 | 20 |
| scroll frame time p50 / p95 | 16.7 / 32.4 ms | **16.7 / 16.9 ms** |
| teardown | 32 ms | 32 ms |

B wins on every line and the reason is structural rather than incidental: under
`fragmented-boxes` every page of a spine document is its own DOM subtree inside ONE instance, so a
frame that holds a chapter can show all of it. The package README says as much — *"a grid should
hold one frame per spine document and present that document's pages into it"* — and the numbers
are what that sentence costs when ignored: A evaluates the fragmenter once per CELL, and the
fragmenter is close to a megabyte.

Re-arranging the boxes is 2.2 ms and the grid comes out as a grid (4 columns × 2 rows observed for
a 6-page document, from measured rectangles, not from the CSS that was asked for).

### V — a frame only paginates while it is ON SCREEN

The one that wrote the virtualisation policy. Same 13-page chapter, nothing else mounted, the frame
placed five ways:

| placement | answered | per page |
|---|---|---|
| fully visible | 2 of 2 | **20.3 ms** |
| half below the fold | 2 of 2 | **20.3 ms** |
| entirely below the fold | **0 of 2** | **no answer at 45 s, twice** |
| `visibility: hidden` | **0 of 2** | **no answer at 45 s, twice** |
| `display: none` | **0 of 2** | **no answer at 45 s, twice** |

Under `fragmented-boxes` the page boxes do not exist in the served bytes: Paged.js builds them in
the frame, and its work queue ticks on `requestAnimationFrame`, which Chromium does not give a
frame that is entirely out of view. The package README already records the analysis-side version of
this trap (a merely-hidden analysis window paginates 47× slower). This is the display-side version,
and it is worse: not slower, *stopped*.

So: **mount a document when its band comes into view and never before.** Pre-fetching the next
chapter would mount a frame that then sits doing nothing until the user scrolls onto it. The
`IntersectionObserver` in this component uses `rootMargin: '0px'` for that reason, and it is a
reason, not a default. A frame that is already paginated costs nothing off screen, so frames are
KEPT once ready (up to `MOUNTED_DOCUMENT_BUDGET`, evicting the least recently seen); a frame still
paginating when its band leaves the viewport is dropped, because it cannot finish and would hold a
renderer process open to do nothing.

#### A note for whoever reads these numbers next

An earlier run of V produced `null` for *fully visible* too. That was **human-triggered, not a
Chromium fault**: the probe's window popped up, Owen moved it behind his editor to get it out of the
way, and Chromium throttles rAF for a window another window covers — a different mechanism from
hidden or minimized, and one that a rAF *counter* inside the window does not reveal. The probe was
given `alwaysOnTop` to remove the desktop's window stacking from the measurement, and the table
above is from that controlled run. **The product viewer is deliberately NOT always-on-top**; that
was a measurement control and would be wrong in an app.

### M and N — minimizing must be legal, and it is

Minimizing at any moment is normal use, so it was tested rather than assumed. Slow while nobody is
looking is fine; *broken* is not.

| | |
|---|---|
| M: window minimized in the middle of a mount, restored 4.0 s later | **completed, 13 of 13 pages, no error** |
| M: an already-mounted frame taken away and brought back | **still mounted, still answering** |
| N: a whole 183-page pagination on the OFFSCREEN analysis host, window minimized throughout | **4,356 ms, 23.8 ms/page, 0 unplaced** |
| N: the same book with the window visible | 23.9 ms/page |

N is the one that matters, and it is a verification rather than a feature: **display and analysis
are two different surfaces**. Opening a book (`electron/quire-viewer-bridge.ts` → `doc.layout()`)
runs on quire's `offscreen: true` analysis host and is completely indifferent to the app window —
23.8 ms/page minimized against 23.9 ms/page visible. Nothing about opening a book depends on the
window the user can cover. Only the DISPLAY frames need to be on screen, and a display frame is
only needed when somebody is looking at it.

---

## What the component is, in one pass

- **Bands.** One per spine document, in spine order, stacked down a scroll column. A band's size is
  arithmetic from `documentPageCount` and the page box the book was laid out into — not an
  estimate — so a placeholder reserves exactly the space its pages will occupy and nothing jumps
  when the frame arrives. Pages of two different chapters cannot share a frame, so a chapter always
  starts a new row; the raster viewer's grid packs pages continuously across the whole book, and
  this is the one visible difference in the grid feel.
- **Marks.** `quire-frame-scripts.ts` holds every script the component says to a frame. One
  stylesheet goes in (allowed by quire's `style-src quire: 'unsafe-inline'`), and struck / selected
  / table-of-contents-selected elements wear classes on the book's own nodes. Whole state, never a
  diff: a diff that drifts leaves a strike on screen for a block that is no longer struck.
- **Hit testing.** The frame reports, once, where every stamped element ended up; clicks are then
  pure arithmetic in Angular against those rectangles. No round trip per click, no coordinates in
  the gestures. Rectangles are measured AFTER the boxes are in their final grid positions and
  BEFORE the zoom transform, so gate G0's rule ("geometry is not pixel-stable across a re-parent")
  is honoured and one measurement stays valid at every zoom.
- **Identity.** A stamped element resolves to the `LaidOutBlock` whose `bf_element` IS that stamp,
  because `electron/quire-stamp.ts` writes the narration element key onto the element. A book whose
  blocks carry no `bf_element`, or two of whose blocks claim the same one, is refused by name.
- **Zoom** is a CSS transform on the page-box container — quire's own mechanism, the same one
  `QuirePageMount.scale` uses. It never reflows, so pagination identity does not change with zoom.
  A font-size zoom would re-fragment the flow and page 41 would stop being page 41, which would
  quietly re-point every page number recorded against the book.
- **Pointer input** belongs to an Angular overlay above the frame (`pointer-events: none` on the
  frame itself). That is what makes marquee rectangles, hover outlines and context menus possible,
  and it is why text selection inside the page is not offered — see "Deferred", below.

---

## Measured on the real book

`node tools/epub-viewer-harness.js <book.epub> --port 4266 --measure out.json`, against the stamped
*Killing America*:

| | |
|---|---|
| open the book (stamp 249 ms + layout 4,283 ms + blocks) | 4,593 ms |
| first page on screen | 4,993 ms |
| bands / pages / blocks | 24 / 183 / 1,360 |
| scroll the WHOLE book | 272 steps, scroll height 169,120 px |
| peak mounted frames | **10** |
| peak DOM nodes in the viewer (Angular's overlay; the book's DOM is out of process) | **668** |
| renderer heap | 66 MB |
| all Electron processes, working set | 1,574 MB |
| bands that refused | **0** |
| bands left stalled mid-mount after the scroll | **0** |
| click | resolved to `OEBPS/fm01.xhtml#0 (body)` — an element key, not a coordinate |
| marquee | selected 7 blocks |
| strike | 1 `.bf-struck` + 1 `.bf-selected` in the LIVE book DOM, stylesheet present |
| **`<script>` elements in the book's document after all of it** | **0** |
| exclude a page | 1 `.bf-page-struck` page box, badge shown |
| zoom ×1.5 | `transform: scale(1.5)`, page-box count and page labels unchanged |

The 262 ms median scroll step is the harness's own 250 ms settle per step, not the viewer's cost.

Two defects the harness found and this component now fixes, both worth keeping in mind for Phase C:

1. **An `IntersectionObserver` reports edges, and an edge can be missed.** A band that was mounted,
   evicted while off screen, and scrolled back to has not changed its intersection state since the
   observer last spoke, so nothing fires and the band sits empty forever. Measured: after scrolling
   the whole book and returning, band 2 was on screen with no frame. The observer now only seeds the
   first paint; `reconcileVisibility()` decides from the rectangles on every scroll.
2. **A cancelled mount is not a refusal.** Scrolling past a chapter mid-pagination used to leave the
   frame alive and stalled (9 of 24 bands, in one run) or, once dropped, to surface as "this chapter
   is broken". Mounts are now cancellable and a cancelled one returns silently.

---

## Deliberately deferred to Phase C

Not omissions — decisions with a reason, listed so they are chosen rather than inherited.

- **Text selection inside the page.** Pointer input is captured by the Angular overlay, so the book
  is not selectable by dragging. The picker's vocabulary is block clicks and marquees, and the
  raster viewer offers no text selection either. Restoring it means routing pointer events into the
  frame and getting the selection back out, which is a design, not a setting.
- **Merge and split.** Both are disabled-never-hidden in the context menu, with the sentence that
  says why. **Settled in Phase C**, both disabled for EPUBs and refused by name in the picker too
  (`mergeSelectionRefusal()`, `splitBlockRefusal()`), including the Merge button in `document-nav`,
  which was enabled and only refused after the click. Split's refusal is not only about the missing
  mupdf spans: the text-mode fallback WOULD have gone through, and a block here is one element, so
  two blocks naming one element means striking either strikes the whole of it.
- **Crop, sample, page reorder, background removal, blanked pages.** All operate on a rasterized
  page. Crop is disabled-never-hidden in the menu; the rest live as controls in
  `pdf-picker.component.ts` (the parent), never in the viewer, so there is nothing here to disable
  — the parent will gate them.
- **Text corrections and chapter-marker bands.** The raster viewer draws corrected text as an SVG
  `foreignObject` over the page. Doing the equivalent on a live page means editing the book's own
  DOM, which is a Phase C decision about what the viewer is allowed to write.
- **Inputs not declared.** This component declares only what it honours. `textCorrections`,
  `blockOffsets`, `blockSizes`, `categoryHighlights`, `pulseRects`, `paragraphBreaks` and the rest
  of the raster viewer's editing surface are absent rather than accepted-and-ignored.
