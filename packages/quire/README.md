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
}
```

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

The document is laid into CSS columns whose width is the page width and whose gap is the gutter,
with a definite height and `column-fill: auto`. Chromium fragments the flow, and **column N is
page N**. Column N's left edge sits at `N * (width + gap)` — the *pitch*.

### The measurement subtlety that decides correctness

`getBoundingClientRect()` returns the **union** box of an element that spans a column break. For
a paragraph broken across a page, that union spans both columns *and the gutter between them*, so
its left edge can land in the gutter and yield a page number that is not merely imprecise but
meaningless.

quire never uses it. It uses **`Range.getClientRects()`** over the element's contents — one rect
per fragment — and maps each fragment to its own column. An element's pages are the SET of columns
its fragments occupy.

### The pitch is checked two ways, and neither rounds

1. **Against the layout, immediately.** The laid-out `column-gap` and `column-width` are read back
   from computed style and compared with the numbers the arithmetic uses. A disagreement is
   refused in the first column of the first document (`COLUMN_GAP_MISMATCH`).
2. **Against the content, continuously.** Every fragment of the whole flow — not just the stamped
   elements — must *begin* inside a column. A fragment beginning in a gutter means the pitch is
   wrong, and since the error compounds by one gutter per column, this catches a mismatch the
   computed style was willing to lie about (`FRAGMENT_IN_GUTTER`).

Check 2 alone is not immediate: drift has to exceed the gutter before a fragment lands in one,
which can take a dozen columns. That is exactly why check 1 exists. Both are tested by doctoring
one number and requiring the refusal.

### Page count is NOT taken from `scrollWidth`

`body.scrollWidth` is the extent of everything that overflows, which includes content overflowing
*sideways* inside a column — a table too wide for the page, an unbreakable URL. On a real book
that makes it disagree with the column count by an arbitrary amount. (It did, immediately, on
`ch09.xhtml` of *Killing America*.) A last column narrower than the page makes it disagree the
other way.

The page count is the highest column any content actually reaches, taken over a Range across the
whole `<body>`. `scrollWidth` is reported as a diagnostic and never used as an answer.

### What quire does to the book

As little as possible, and all of it stated. The book's own markup and stylesheets are left in
place and load normally, so `body > p.first` still matches what the book meant by it. On top of
that, and only that:

- the page box is forced onto `html` and `body` — margin, padding, border, size, overflow;
- the multi-column properties are forced onto `body`;
- replaced elements are capped at `max-width: 100%` so an oversized figure cannot silently
  redefine the pitch. **Height is deliberately not touched**: a figure taller than the page is
  allowed to be sliced across pages, which is what mupdf's rasterizer does to the same figure.

Forcing `body` margin to 0 means the page box *is* the column box. Callers that want page margins
add their own. This is why quire's page count for a given book will not match mupdf's — mupdf
applies its own page margins, so it fits less text per page.

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

If a page cannot be brought to the origin, both paths **throw**. A cell that quietly shows page 0
while claiming to be page 40 is the one outcome worth refusing outright.

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
```

Dependencies: `electron` and `@xmldom/xmldom`. Note that `@xmldom/xmldom` is present but
**undeclared** in the repo's `package.json` — a pre-existing condition (`epub-processor.ts`
already relies on it), not something quire introduced.

## Running it

```
node tools/quire-paginate.js <book.epub> [--width 600] [--height 900] [--font-size 18]
                                         [--gap 24] [--json out.json] [--png <page> <file>]
node tools/test-quire.js
```

Both re-launch themselves under Electron, because quire paginates in a real browser and there is
no browser in plain Node. That is the point of the package, so the harnesses make it obvious
rather than hiding it.

### Integration gotcha

quire's analysis window is a real `BrowserWindow`. Destroying it can leave an app with no windows,
and Electron's default reaction to that is to **quit**. BookForge's main window keeps the app
alive; a headless harness must handle `window-all-closed` itself.
