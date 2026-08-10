# quire

A sandboxed, browser-based paginator for EPUBs.

A *quire* is the gathering of leaves that gets folded and sewn into a book: the thing that turns
a text into pages.

---

## Why this exists

EPUBs are paginated today by mupdf, which rasterizes pages and reports blocks as bare bounding
boxes with **no link back to the markup**. Recovering "which markup element is this block" from
geometry is a heuristic, and that heuristic failing is the root of a long chain of deletion bugs.

A browser paginates the real DOM, so the link is never lost. quire hands back the caller's own
element id on every block it produces, because the caller put it there.

The second thing that falls out of using a browser: a page can be **shown** rather than
photographed. `getPageMount()` gives a display surface everything it needs to put a page on
screen as live DOM — selectable text, real fonts, working internal links. `toPng()` still exists,
for thumbnails and for diffing against mupdf during the changeover, but it is not the display
path and is not meant to become one.

---

## The contract

Deliberately close to the slice of mupdf that `electron/pdf-analyzer.ts` drives, so it can be
swapped in without rewriting the call sites around a new idea.

```ts
import { Quire } from '../packages/quire/src';

Quire.registerScheme();                 // module scope, BEFORE app.whenReady()

const doc = await Quire.openDocument(stampedEpubPath);
const report = await doc.layout({ width: 600, height: 900, fontSize: 18 });

doc.countPages();                       // number
const page = doc.loadPage(0);
page.getBlocks();                       // QuireBlock[]
page.getMount();                        // QuirePageMount — how to SHOW this page
await page.toPng(1);                    // Buffer (thumbnails / mupdf diffing only)

await doc.close();
```

### Two differences from mupdf, both on purpose

**`layout()` is async, and must be awaited.** A browser lays out asynchronously and there is no
honest way to pretend otherwise. `countPages()` and `loadPage()` refuse to answer before it has
resolved rather than answer from a stale layout.

**`QuireBlock` carries an `id`.** This is the entire point:

```ts
interface QuireBlock {
  type: 'text' | 'image';
  bbox: { x: number; y: number; w: number; h: number };  // page-local, CSS pixels
  text: string | null;      // null for images; the words on THIS page for a split element
  id: string;               // the caller's own id, handed straight back
  splitFrom: number | null; // first page this element occupies, if it spans pages
  splitTo: number | null;   // last page, if it spans pages
  font: { size, family, weight, style } | null;  // how it is SET; null for images
  lines: number;            // line boxes on THIS page; 0 for images
}
```

`font` and `lines` are there because they are facts **only the engine that applied the book's
stylesheets can state**, and a caller that has to fill a `font_size` field will otherwise invent a
number. `font` is per ELEMENT — a paragraph broken over a page turn is set in one face — and `lines`
is per FRAGMENT, counted from the client rects of a `Range` over the fragment's contents rather than
divided out of the box height, which is wrong the moment a paragraph mixes type sizes.

An element that spans a page break produces one block per page it touches. Each carries the same
`id` and the same `splitFrom`/`splitTo`, and each carries only the box — and only the words —
that are actually on that page. The fragments rejoin into the original text exactly once; they
never repeat it.

---

## Identity — the caller owns it, quire only reports it

**quire does not mint ids.** The caller stamps elements with `data-quire-id` before pagination,
and quire reports that exact string back on every block.

This is not fastidiousness. BookForge's element keys — `file#<index>` for text units,
`file#img<N>` for images — are minted by `collectExportUnits` / `collectImageElements` in
`electron/epub-processor.ts`, and the export writer `writeNarrationEpub` walks the book with
those **same** functions to decide what a deletion removes. If quire stamped its own ids there
would be two enumerations of one book, they could drift, and every deletion bug that came from
geometry-guessed identity would come back. Because the caller stamps, identity is correct by
construction.

`electron/quire-stamp.ts` is BookForge's stamper. It does not describe the enumeration, it
**calls** it — same functions, same order, same per-document dedupe — and writes each key onto
the very element the walk returned. `tools/test-quire.js` compares the result against a reference
walk written out longhand, so a future edit that makes the two disagree has something to fail
against.

### Several ids on one element

One element can be both a text unit and an image element (a bare `<img>` under `<body>` is
collected by both walks). `data-quire-id` therefore holds a `|`-separated list, and quire emits
one block per id. A key containing a `|` is **rejected at stamp time** rather than escaped.

### Elements that get no page

Books legitimately contain elements that render nothing — `display:none`, an empty paragraph, a
wrapper whose every child is out of flow. These are reported as first-class results, never
silently omitted:

```ts
report.unplaced;              // QuireUnplaced[] — id, document, tag, computed display, hasText
doc.assertEveryStampPlaced(); // throws, naming them, for callers that cannot tolerate one
```

On *Killing America* (24 documents, 1360 stamped elements) this number is **0**.

---

## How pagination works

Behind `QuireStrategy` (`src/paginate/strategy.ts`) — and there are two implementations, which are
**not** alternatives:

| | `PagedStrategy` | `MultiColumnStrategy` |
|---|---|---|
| what | Paged.js 0.4.3, vendored | CSS multi-column |
| box model | `fragmented-boxes` | `continuous-columns` |
| role | **the product**, and `openDocument`'s default | the **adversarial test fixture** |

There is no fallback between them. A book paginates with the strategy it was opened with or the
open fails naming why, and a cached page map is only valid for the paginator that produced it —
which is why `doc.strategyName` exists and why the strategy names its version (`pagedjs-0.4.3`).

### PagedStrategy — the product

`@page { size: <width>px <height>px; margin: 0 }` is handed to Paged.js's polisher, and Paged.js
chunks the flow into `.pagedjs_page` boxes stacked down one document. **Each page is its own DOM
subtree**, so a grid can mount many pages from a single instance and a page can be brought to a
surface's origin by scrolling rather than by translating a 115,840px-wide strip.

The engine is injected as the strategy's **prelude**: evaluated in the *isolated world*, from the
main process, exactly like the measurement. It is never a `<script>` in the book's document — the
book is still served under `script-src 'none'` with every `<script>` stripped from the bytes — so
the book's own world can neither see `Paged` nor call it. `tools/test-quire.js` proves the book's
document still holds zero `<script>` elements after a page has been built and shown.

**A page number is decided twice, and a disagreement is refused.**

1. *quire's own*, from geometry: which page box an element's `Range.getClientRects()` land in.
2. *Paged.js's own*, from the mapping it used: `data-ref` groups an element's clones, and
   `data-split-from` / `data-split-to` say which of them are continuations.

Trusting the attributes alone would trust an attribute; trusting the geometry alone would throw
away the engine's own answer. So both are computed for every stamped element of every document and
compared, and `SPLIT_DISAGREEMENT` names the element when they differ. The test suite proves that
refusal fires by wrapping `Previewer.preview` and removing one `data-split-to` from an otherwise
perfect pagination.

One shape of that disagreement is told apart before it is reported, because it is a different fault
with a different cure: an element present **whole on two pages**, the same words on each and no
marker on either, was never split at all — Paged.js gave up on an item it could not fragment and
emitted it twice. That is `CONTENT_REPEATED`, and it names the page to go looking at.

**The page box is checked against the layout**, the counterpart of multi-column's
`COLUMN_GAP_MISMATCH`: if `@page { size }` never reaches the fragmenter, Paged.js silently uses its
own default (US Letter) and every coordinate would be measured against a box that is not the page.
Every `.pagedjs_page_content` must lay out at exactly the asked-for size or `PAGE_BOX_MISMATCH`.

Page identity here comes from DOM containment, not from geometry — an element is a descendant of
one `.pagedjs_page` and of no other — so a fragment that reaches *outside* its page box is not an
ambiguity to refuse but a fact to report. It goes into `report.overflows` with the axis it ran off
and how far, and Paged.js clips it, which means it is content the reader will not see.

### What PagedStrategy does to the book

More than multi-column does, and all of it stated:

- the book's own `<style>` and `<link rel=stylesheet>` are taken out and handed to Paged.js's
  polisher as **text read back from the CSSOM**. Paged.js has to rewrite `@page`, `break-*` and the
  split pseudo-elements, and its own way of getting the text is to *fetch* the href — which the
  `quire://` scheme deliberately does not support. Reading the CSSOM is lossless with respect to
  what is actually in force: a rule Chromium did not parse was never applied. A `<link>` pointing
  off `quire://` is dropped, decided **on the href before anything is read** — a blocked
  cross-origin sheet is not absent, Chromium still exposes a `CSSStyleSheet` whose `cssRules`
  throw, and telling that apart from a genuinely broken sheet inside the archive by catching the
  `SecurityError` would be reading the sandbox's mind;
- Paged.js re-parents content into page boxes, cloning the ancestor chain onto every page an
  element continues on. **`body > p` therefore stops matching**, where under multi-column it still
  would. That is inherent to fragmenting into boxes and is the price of the box model;
- replaced elements are capped at the **page box, height included**. This is the difference that
  decided gate G0. A book that says `max-height: 100%` on a plate is saying nothing at all — a
  percentage max-height resolves against an auto-height containing block and computes to `none` —
  which is how a 2400px plate ends up laid out at 2400px inside a 900px page;
- the viewport's scrollbar is taken to zero width. The page boxes must be scrollable, and a
  scrollbar would take its width out of the layout viewport, so a surface sized to the page would
  show the page minus a scrollbar and a raster of it would have its right edge sliced off. This
  changes what is drawn, never what is laid out;
- **the book's own elements are held to `overflow: visible` inside a page box**
  (`MONOLITHIC_OVERFLOW_RULE`). CSS Fragmentation calls a box with `overflow` other than `visible`
  *monolithic*: it is a scroll container, and a scroll container is never broken across
  fragmentainers. Paged.js fragments by laying the page content out one column wide and moving what
  lands past that column onto the next page, so a monolithic box **taller than the column cannot go
  anywhere**: Chromium pushes it out of the visible column whole, Paged.js's `findBreakToken` takes
  its "stop removal if we are in a loop" branch, warns `Unable to layout item`, keeps the overflow
  in the page and restarts the next page at the following sibling. What comes out is a blank page
  followed by a page whose every element is *also* still in the previous page's clipped overflow.
  Measured on the CES letter (2026-08-10), whose converter wraps every table in
  `.tablewrap { overflow-x: auto }`: an 859px table in an 804px content box did this three times in
  one chapter and the book would not open. `overflow: auto` is a statement about a scrolling
  viewport and a page box is not one, so it is neutralised — gated to descendants of
  `.pagedjs_page_content` (never Paged.js's own chrome), to the `overflow` property alone, and not
  to replaced elements, where `overflow` means "clip the replaced content". It is a **pagination-wide
  change** and cost a `QUIRE_ANALYSIS_VERSION` bump (v2 → v3). It is not a substitute for the
  refusal: a book can still defeat it with an id-selector `!important`, and `break-inside: avoid` on
  something taller than a page reaches the same Paged.js branch by another road, so
  `CONTENT_REPEATED` stays.

### MultiColumnStrategy — the test fixture

Kept because it is the strategy whose arithmetic can be **wrong in an interesting way**. The
document is laid into columns whose width is the page width and whose gap is the gutter, with
`column-fill: auto`; Chromium fragments the flow and **column N is page N**, with column N's left
edge at `N * (width + gap)` — the *pitch*. Get the pitch wrong and page numbers drift by one more
column every column, silently and confidently. That is a failure mode worth having something to
test against, and `tools/test-quire.js` subclasses this to lay a document out at one gutter and
measure it at another.

Its measurement subtlety is worth keeping written down, because it is the same trap in any
column-based reader: `getBoundingClientRect()` returns the **union** box of an element spanning a
column break, whose left edge can land in the gutter and yield a page number that is not merely
imprecise but meaningless. It uses `Range.getClientRects()` — one rect per fragment — instead. The
pitch is then checked two ways and neither rounds: against the laid-out `column-gap`/`column-width`
immediately (`COLUMN_GAP_MISMATCH`), and against every fragment of the whole flow continuously
(`FRAGMENT_IN_GUTTER`), because drift has to exceed the gutter before a fragment lands in one and
that can take a dozen columns. Its page count is the highest column any content reaches, never
`body.scrollWidth` — `scrollWidth` includes content overflowing *sideways* inside a column, which
on `ch09.xhtml` of *Killing America* disagrees with the column count immediately.

### Common to both

`html`/`body` margin, padding and border are forced to 0, so the page box *is* the content box.
Callers that want page margins add their own. This is why quire's page count for a given book will
not match mupdf's — mupdf applies its own page margins, so it fits less text per page. Measured on
*Killing America* at `{600, 900, 18}`: quire 183 pages, mupdf 218.

**TODO (display fidelity, Phase B).** With margin 0 a long unbreakable token — a bare URL in a
citation — runs to the page edge and Paged.js clips it. quire *reports* that (`report.overflows`,
2 fragments on *Killing America*) rather than hiding it, and no page number is affected, so it is a
question about what the reader SEES rather than about the map. It is left for the viewer phase, where
the answer is a page margin or a wrap rule and can be judged against a page on screen.

### The analysis host must get frames, and that is not obvious

Paged.js's work queue ticks on `requestAnimationFrame`, so its throughput is whatever frame rate
the surface is given. Measured here on one 13-page chapter of *Killing America*:

| analysis host | rAF | per page |
|---|---|---|
| `offscreen: true` (what quire uses) | 61 fps | **18 ms** |
| shown at opacity 0, parked off-screen | 60 fps | **18 ms** |
| hidden and NOT offscreen, `backgroundThrottling: false` | 61 fps | 855 ms |
| hidden and NOT offscreen, throttling left on | 61 fps | 853 ms |
| minimized | 60 fps | 854 ms |
| `offscreen: true`, frame rate forced to 1 | 1.5 fps | 1076 ms |

Two things in that table are worth saying out loud. A merely-hidden window paginates at about one
page per second — 47× slower — and `backgroundThrottling` does not touch it. And a rAF *counter*
inside that window still reads 60 fps: the callbacks fire, the layout work between them does not
progress, so counting frames alone would not have found this. `tools/test-quire.js` therefore holds
the book to **milliseconds per page** as well as measuring the frame rate, because every page number
would still be RIGHT if this regressed — it would just take two and a half minutes instead of four
seconds.

---

## Strategy — SETTLED (gate G0, 2026-08-08): Paged.js is the fragmenter

Pagination sits behind `QuireStrategy` (`src/paginate/strategy.ts`). A strategy owns three
artifacts and nothing else: the CSS that makes page boxes, a pure script that MEASURES, and a pure
script that PRESENTS one page at the surface origin.

The spike (`spike/epub-paginated-viewer`, evidence JSON + screenshots in its
`tools/spike-epub-viewer/evidence/`) measured Paged.js 0.4.3 against CSS multi-column on Killing
America (24 spine documents, 3,475 stamped elements, 10 images). The decision is **Paged.js,
vendored, as a `fragmented-boxes` strategy** — and these are the numbers that made it:

- **Element coverage**: 0 of 3,475 elements without a page — in BOTH candidates. Coverage did not
  decide this.
- **Images**: Paged.js put all 10 images each on exactly ONE page. mupdf straddles two of bm01's
  plates across page breaks; multicol reproduces exactly that failure (a different two). Paged.js
  detects the overflow and moves each over-tall plate to a fresh page. 10 elements → 10
  unambiguous pages.
- **Identity is carried, not inferred**: 74 elements split across pages, and Paged.js's own
  `data-split-from`/`data-split-to` count is exactly 74 — the mapping (`data-ref`) survives
  re-parenting (3,732 attributes intact after moving all 183 page boxes into a grid).
- **Grid cells**: re-parenting all 183 `.pagedjs_page` boxes into a 4-column grid took 185 ms with
  0 of 3,549 rendered nodes changing page. Mount/unmount for virtualization: 0.9 ms/page,
  DOM 16,374 → 1,203 nodes for a 12-page window. Multi-column cannot produce a grid at all — it
  is one continuous strip (a 115,840 px-wide layout, and the WORSE of the two on memory:
  288 MB vs 231 MB).
- **Determinism**: three consecutive runs, identical page count, identical uid→page map, identical
  rects, both candidates — so caching the page map is sound, keyed by engine version + CSS +
  page box.
- **Streaming**: first page at 47 ms, then ~16.7 ms/page, exactly linear. Full book 3.1 s — slower
  than multicol's 61 ms, but pagination streams and the map is cacheable, so the speed loss buys
  correct image placement and real per-page DOM subtrees.
- **The known trap**: Paged.js's work queue ticks on `requestAnimationFrame`, and a hidden
  `BrowserWindow` throttles rAF to ~1 Hz (a 60× slowdown). The host must be offscreen-rendered or
  shown (opacity 0, parked off-screen) — never merely hidden.

`MultiColumnStrategy` stays in the tree as the adversarial test fixture (the gutter/pitch
refusal tests subclass it) — it is NOT a runtime fallback. A book paginates with Paged.js or the
open fails naming why; a cached page map is valid only for the paginator that produced it.

`QuirePageMount.boxModel` is public because it is a fact a display surface has to plan around:

- **`continuous-columns`** (what multi-column gives) — a document is ONE flow and a page is a
  window onto it. Showing page N means loading the chapter and translating it. **A grid of pages
  needs one document instance per visible cell, so it MUST virtualise.**
- **`fragmented-boxes`** — each page is its own DOM subtree in one instance; a grid can mount many
  pages from a single instance.

---

## Showing a page

Two ways, both driving the same strategy scripts as the measurement — which is what keeps what the
user sees and what was measured the same thing, by construction rather than by agreement.

**Main process**, for a WebContents the app owns and displays (`<webview>`, `WebContentsView`):

```ts
const host = AttachedWebContentsHost.attach(view.webContents, doc.session);
await doc.presentPage(42, host);
```

**Renderer**, from the plain-data mount descriptor:

```ts
import { mountQuirePage } from '../packages/quire/src/mount';
const mounted = mountQuirePage(mount, cell, { partition: `quire-${sessionId}` });
await mounted.ready;   // rejects, naming the page, if it could not show that page
mounted.destroy();
```

`mount.ts` imports nothing — not Electron, not Node — so it bundles into the Angular app without
dragging the main-process half along.

Both paths run `mount.preludeScript` first and `mount.presentScript` second, because under
`fragmented-boxes` **the page boxes do not exist in the served bytes** — they are built in the
frame. That prelude is the same near-megabyte string for every page of the book, which is the
reason a grid should hold one frame per *spine document* and present that document's pages into it
rather than one frame per cell. `mountQuirePage` mounts one page into one frame because that is the
only thing that works for both box models; the saving is the caller's to take.

If a page cannot be brought to the origin, both paths **throw**. A cell that quietly shows page 0
while claiming to be page 40 is the one outcome worth refusing outright. And `presentScript` waits
for the surface to actually paint the new position before it says so: `capturePage` hands back the
last painted frame, so a surface scrolled and photographed in the same turn produces a confident
picture of the page it used to be showing.

---

## Sandbox guarantees

Book HTML is untrusted content. These are not tuning knobs.

**The surface.** Every host must satisfy `QUIRE_REQUIRED_WEB_PREFERENCES` — `sandbox: true`,
`contextIsolation: true`, `nodeIntegration: false`, `nodeIntegrationInSubFrames: false`,
`webSecurity: true`, `allowRunningInsecureContent: false`, `experimentalFeatures: false`,
`webviewTag: false`, no `enableBlinkFeatures`. `assertSandboxed()` reads the preferences back from
the live WebContents and **refuses** rather than trusting what was passed at construction. There
is no preload: measurement is injected from the main process into an **isolated world**, so the
book can neither see nor tamper with it, and returns a string. `setWindowOpenHandler` denies. The
analysis window is never shown and is destroyed on every exit path, including the failing ones.

**The bytes.** The book's resources are served only through `quire://<session>/<zip entry>`, out of
the archive, from a Map built from the ZIP central directory. There is no filesystem path anywhere
in the lookup, so there is no path to escape from.

**Traversal is refused, not normalised.** A request containing a `..` segment, a `.` segment, an
empty segment, a backslash, a drive letter or a NUL is a 403 that names the rule. This matters more
than it looks: `quire` is a *standard* scheme, so the WHATWG URL parser collapses `a/../b` to `b`
before a handler would see it. quire therefore takes the path from the **raw URL**, not from
`URL.pathname` — otherwise every traversal would arrive pre-collapsed and be served, and the code
that "refuses traversal" would be decoration.

**No network.** Two independent mechanisms, so neither is a single point of failure:

- a CSP, set as **both** a response header and a `<meta>`: `default-src 'none'`, `script-src
  'none'`, `connect-src 'none'`, `object-src`/`frame-src`/`child-src`/`worker-src`/`media-src`
  `'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'` (header only — a
  `<meta>` cannot carry it), and `img-src`/`style-src`/`font-src` limited to `quire:` and `data:`;
- `session.webRequest.onBeforeRequest` **cancels everything that is not `quire:`**, which is the
  one that still holds if a book ever found a CSP hole.

`bypassCSP` is deliberately **false** on the scheme — the opposite of `bookforge-page` — because
the point is that the CSP applies to the book.

**No script.** Every `<script>`, every `on*` attribute and every `javascript:` URL is stripped from
the bytes in the main process *before* they are served. The CSP would refuse to execute them
anyway; this is the second mechanism. A book carrying script is not rejected, it is served without
it.

**Including the fragmenter.** Paged.js is a megabyte of JavaScript that has to run against the
book's DOM, and none of the above loosens for it. It goes in as the strategy's *prelude* —
evaluated in the isolated world, from the main process, the same channel the measurement uses — so
the book's document is served with `script-src 'none'` and no `<script>` in it, before and after.
The engine also never reaches the book by the side door: its polisher's own way of reading a
stylesheet is to `fetch()` the href, and `quire://` is registered with `supportFetchAPI: false`, so
the CSS is read out of the CSSOM the browser already built instead. Nothing in a quire document
fetches anything.

**No permissions, no storage.** `setPermissionRequestHandler`/`setPermissionCheckHandler` deny
everything. Each document gets its own non-persistent partition (`quire-<random>`, no `persist:`
prefix), so the book gets no cookies, cache or storage that outlives it, and shares none of
BookForge's.

Every refusal is recorded and readable: `doc.refusals` and `doc.consoleMessages`.

### How this was verified

`tools/test-quire.js` — a book carrying `<script>`, an `onclick`, a `javascript:` href, and remote
`<img>`/`<link>` references is paginated, and afterwards: the script did not run (no attribute it
would have set), no `<script>` element reached the renderer, the shell reports what it removed, and
the remote references produced either a CSP violation or a cancelled request. A book referencing
`../../../../Windows/win.ini` produces a recorded refusal. Attaching a book to a deliberately
unsandboxed WebContents throws `SANDBOX_VIOLATION`. On *Killing America*: 0 requests escaped, 0 CSP
violations.

---

## Failure policy

**No fallbacks.** Everything in this package throws a `QuireError` naming what could not be
determined rather than substituting a default. A wrong page number is worse than no page number,
because a wrong one is believed. In particular quire refuses — rather than guesses — when:

| code | when |
|---|---|
| `SCHEME_NOT_REGISTERED` | `registerScheme()` was not called before app ready |
| `NOT_LAID_OUT` | pages were asked about before `await layout()` |
| `PAGEDJS_BUNDLE_MISSING` / `PAGEDJS_BUNDLE_UNRECOGNISED` | the vendored fragmenter is not there, or is not the pinned version |
| `PRELUDE_FAILED` | the strategy could not put its engine into the frame |
| `PAGE_BOX_MISMATCH` | a laid-out page box is not the box the arithmetic assumes |
| `FONT_UNREADABLE` | a text element's computed font size or weight is not a number |
| `SPLIT_DISAGREEMENT` | Paged.js's record of a split and the measured pages disagree |
| `CONTENT_REPEATED` | one element is present WHOLE on two pages — Paged.js could not fragment an item and emitted it twice |
| `OCCURRENCES_NOT_CONTIGUOUS` / `FRAGMENTS_NOT_CONTIGUOUS` | an element left a page and came back |
| `REF_COLLISION` / `NO_DATA_REF` / `DUPLICATE_STAMP` | element identity cannot be reconciled |
| `STYLESHEET_UNREADABLE` | a stylesheet inside the archive produced no readable CSSOM |
| `PAGINATION_RUNAWAY` / `PAGE_COUNT_DISAGREEMENT` | the fragmenter did not converge, or cannot say how many pages it made |
| `COLUMN_GAP_MISMATCH` / `COLUMN_WIDTH_MISMATCH` | the layout's pitch is not the arithmetic's |
| `FRAGMENT_IN_GUTTER` | a fragment begins in a gutter |
| `SPLIT_NOT_ORDERED` | a split element's characters do not run in column order |
| `SANDBOX_VIOLATION` / `SANDBOX_UNVERIFIABLE` | a surface is not, or cannot be shown to be, sandboxed |
| `HOST_WRONG_SESSION` | a display surface could not resolve `quire://` — would render blank |
| `PRESENT_FAILED` | a page could not be brought to the origin |
| `UNKNOWN_CONTENT_TYPE` | an archive entry's type cannot be stated (sniffing is not an option) |
| `DOCUMENT_UNPARSEABLE` | a spine document is not XHTML |
| `EPUB_HREF_UNRESOLVED` / `EPUB_EMPTY_SPINE` | the book's own structure does not add up |

---

## Building

Compiled by the electron build — `packages/quire/src/**/*` is in `tsconfig.electron.json`, and
emits to `dist/packages/quire/src/`. `packages/quire/tsconfig.json` builds the package on its own
to the **same** output layout, so there is only ever one build on disk:

```
npx tsc -p tsconfig.electron.json          # app + package
npx tsc -p packages/quire/tsconfig.json --noEmit   # package alone
npm run build:quire-vendor                 # copy vendor/ beside the compiled output
```

That last step is not optional and not a fallback: `PagedStrategy` reads the vendored bundle from
`<quire package root>/vendor/pagedjs/paged.js` at run time, resolved relative to the compiled
module, and refuses by name if it is not there. `npm run build:electron` does it; so do
`npm run test:quire` and `npm run quire:paginate`.

Dependencies: `electron` and `@xmldom/xmldom`. Note that `@xmldom/xmldom` is present but
**undeclared** in the repo's `package.json` — a pre-existing condition (`epub-processor.ts`
already relies on it), not something quire introduced.

Paged.js is **vendored, not installed** — `packages/quire/vendor/pagedjs/`, with its MIT licence,
its exact provenance and the sha256 of the byte-for-byte artifact recorded in the README beside it,
and a `.gitattributes` marking it `-text` so `core.autocrlf` cannot rewrite it. Nothing was added
to the repo's dependencies. `tools/test-quire.js` checks that hash, so a bundle that quietly became
something else fails a test instead of paginating a book differently.

## Running it

```
node tools/quire-paginate.js <book.epub> [--width 600] [--height 900] [--font-size 18]
                                         [--gap 24] [--strategy paged|multicol]
                                         [--json out.json] [--png <page> <file>]
node tools/test-quire.js
```

`--strategy multicol` selects the test fixture rather than the product. It is there so the two can
be compared on the same book on demand — that comparison is what decided gate G0 — not because a
caller gets to pick a fragmenter.

Both re-launch themselves under Electron, because quire paginates in a real browser and there is
no browser in plain Node. That is the point of the package, so the harnesses make it obvious
rather than hiding it.

### Integration gotcha

quire's analysis window is a real `BrowserWindow`. Destroying it can leave an app with no windows,
and Electron's default reaction to that is to **quit**. BookForge's main window keeps the app
alive; a headless harness must handle `window-all-closed` itself.
