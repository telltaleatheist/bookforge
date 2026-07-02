# Import → Edit → Listen (mobile pipeline)

A phone-first content pipeline for the **bookshelf web app**: import anything
(URL / epub / pdf / pasted text) → rudimentary on-device edit (crop, delete,
chapter markers) → export to `exported.epub` → open in the reader → stream it
with the TTS engine, in one of two modes.

> **Reuse first.** The streaming engine, the ±buffer read-ahead, the prefetch/LRU
> cache, and sentence-click-to-start already exist in `extension/` and in
> `reader-playback.service.ts` (ported from `offscreen.ts`). This project makes
> that machinery reachable from a phone and adds the three genuinely new pieces:
> **(1)** the two-mode editor, **(2)** a *persistent* whole-book renderer that
> writes sentences to disk, and **(3)** completion → m4b on the audiobook page.

Locked decisions (asked + answered 2026-07-02):
- **Entry point:** the **＋** at the bottom of the bookshelf opens a **sliding
  bottom-sheet** with two choices — *Import a file* (pdf/epub/…) or *Paste a URL*.
  A URL is downloaded and **treated exactly like an epub** (converted, edited,
  processed the same way — just with an article marker).
- **Every import is a persisted project.** Text always survives; audio may not:
  - The edited **text** (`source/exported.epub`) **always** persists in the
    library (article-tagged so it stays out of the Ebooks tab), processed "just
    like a regular book."
  - **Audio persistence is a separate axis from the project.** Full-book render →
    sentences saved → m4b. Follow-along/streaming → audio is **ephemeral**
    (cleared when the reader closes); only the text/project remains.
  - Projects are **user-deletable** ("clear projects as they wish").
- **Full-book engine:** one **unified live renderer** — streams to disk
  sentence-by-sentence, prioritises from the playhead outward + wraps to the
  front, playable live while it fills in, assembles an m4b at 100 %.
  Follow-along is the *same* renderer with a ±45 s window (and no disk).
- **PDF crop = block filter.** Output is text→epub; the crop rect just excludes
  text blocks whose box falls outside it. "Apply to all" drops those blocks on
  every page. Page image is shown only so the user sees what's excluded.
- **Two editor modes**, both in the **bookshelf web app** (phone-first): a
  page-crop editor for PDF, a linear block-list editor for epub/URL/text.

---

## Grounded backend seams (verified 2026-07-02)

| Need | What exists | Where |
|---|---|---|
| Stream a session forward | `start(sentences, startIndex, settings, requestId, sink, opts)`; forward-only, ephemeral | `electron/stream-scheduler.ts:114` |
| **Render ONE sentence → bytes** | `getActiveEngine().generateSentence(text, index, settings, priority?, isCancelled?) → {success, audio?}` (base64) | `electron/streaming-engine.ts:45` |
| Reader WS transport | `/api/reader/ws`, `speak/playhead/cancel` in, `chunk/done/complete` out | `electron/reader-stream-bridge.ts` |
| PDF page raster (PNG) | `GET /api/read-page?ref=&page=&scale=` (scale default 2, 0-based page) | `electron/bookshelf-server.ts:277` → `renderPdfPage` |
| PDF block boxes | `PDFAnalyzer.analyzeText()` → `TextBlock{page,x,y,width,height,text,region,…}` (points, top-left); page dims on `this.pageDimensions` after `analyzeQuick` | `electron/pdf-analyzer.ts:86,741` |
| Header/footer pre-tag | `region ∈ {header,footer,body,lower}` already computed | `electron/pdf-analyzer.ts:1117` |
| Block ingest (epub/url/text) | `ingestFromUrl/Pdf/Epub/Text` → `{title, blocks[]}` | `electron/reader-ingest.ts` |
| m4b assembly (existing) | e2a `app.py --assemble_only --sentences_dir <dir>`; expects `<index>.flac` (0-based) or `.wav`, needs session-state | `electron/reassembly-bridge.ts`, `parallel-tts-bridge.ts:3182` |
| Register finished m4b | `manifestService.registerAudiobookOutput(m4bPath)` → pairs sibling `.vtt`, writes `outputs.audiobook`; surfaces on **Bookshelf + Studio grid** | `electron/manifest-service.ts:564` |
| Create a project (typed) | `manifestService.createProject(projectType:'book'|'article', source, metadata)` — full folder tree, UUID id | `electron/manifest-service.ts:254` |
| HTML→epub (single chapter) | hand-rolled zip writer, **1 chapter only** — must generalise to N | `electron/main.ts:8920` |

**Gotchas the map flagged:**
- `startIndex` only moves **forward**; no backward generation. → the persistent
  renderer bypasses the scheduler and calls `generateSentence` with **its own
  ordering**, so wrap-around is ours to control.
- **Nothing streamed is persisted server-side today.** New disk cache required.
- Chunk bytes differ by path (streaming = raw **PCM16 24 kHz mono**, batch =
  "WAV"). → wrap PCM16 → WAV before writing to disk.
- `generateSentence` needs the engine **started** (session active). → the render
  service owns engine lifecycle.
- The existing HTML→epub writer is **single-chapter**; chapter markers require a
  small multi-chapter generalisation.
- e2a `--sentences_dir` assembly needs a reconstructed **session-state** — see
  Phase G, where a direct ffmpeg assembler is recommended instead.

---

## Data model

Per project, a new render workspace (mirrors e2a's `chapters/sentences` naming so
existing assembly stays an option):

```
<projectDir>/
  source/exported.epub        # editor output (pipeline-source-model: source of truth)
  render/
    plan.json                 # ordered sentences + chapter map (from the epub)
    sentences/<index>.wav     # rendered audio, 0-based, written as it completes
    state.json                # { mode, coverage:[bool], durations:[sec], cursor, playhead, engine, voice }
  output/<title>.m4b          # Phase G, on 100%
  output/<title>.vtt          # synced transcript, built from durations
```

`plan.json` is the join between editor and renderer: the ordered sentence list
(from `splitForTts` over the epub text) plus `sentenceIndex → chapterIndex`.
`state.json` makes the render **resumable across app restarts** (skip indices
already `true` in `coverage`).

---

## Phase A — Import intake + editor doc model
*bookshelf web app + one new server endpoint*

1. The bottom **＋** opens a **sliding bottom-sheet**: *Import a file*
   (pdf/epub/txt) or *Paste a URL* (downloaded, converted to epub). Reuses the
   raw-bytes upload + `ingestReader` plumbing. (The existing paste-text quick
   Listen can stay as a lighter ephemeral path.)
2. New `GET/POST /api/edit/ingest` returns an **editable doc model**, not just
   blocks:
   - **PDF** → `{ mode:'page', pages:[{ index, width, height, blocks:[{id,x,y,w,h,text,region}] }], defaultCropExcludes }`. Reuses `PDFAnalyzer.analyzeText` + `this.pageDimensions`; `region∈{header,footer}` pre-marked excluded.
   - **epub / url / text** → `{ mode:'flow', blocks:[{id,text,tag}] }` via `ingestFrom*`.
   Doc is cached server-side under a `docId` (ephemeral tmp), raw source retained
   for export.
3. New Angular route `edit/:docId` → `EditorComponent`, dispatches to page or
   flow sub-view by `mode`.

## Phase B — Flow editor (epub / url / text)
*simplest; ships value first; also retires the deprecated Studio article flow*

- Linear scrollable block list (phone-sized).
- Per block: **delete**, tap → toggle **Chapter start** (▸ marker), optional merge.
- Bottom bar: **Ebook / Article** tag toggle (default: URL→Article, file→Ebook),
  **Done**.
- Done → Phase D with the surviving ordered blocks + chapter markers.

## Phase C — Page editor (PDF)
*the "mupdf-like" cropper*

- Render each page via `/api/read-page?ref=&page=&scale=2`; overlay block boxes
  (scale points→px by the same `scale`). Header/footer boxes start dimmed/excluded.
- **Crop rect**: drag a rectangle; blocks whose box falls outside → excluded
  (greyed). **Apply to all** copies the rect to every page (kills page
  numbers/headers/footers in one gesture).
- **Delete page** (drops all its blocks); **tap block** → toggle delete; tap →
  **Chapter start**.
- Crop/delete are pure **block filters** — no image is kept; the audio comes from
  surviving blocks' text, sorted `(page, y)`.
- Same **Ebook/Article** toggle + **Done**.

## Phase D — Export → `exported.epub` + project
*closes the earlier Studio import-chooser + URL→epub items, bookshelf-side*

1. Generalise the hand-rolled writer (`main.ts:8920`) into
   `blocksToEpub(chapters: {title, html}[], metadata) → epubPath` — N chapters:
   N `chapterK.xhtml` + manifest/spine/nav entries (currently hardcoded to 1).
   Chapters come from the editor's Chapter-start markers (before the first
   marker = "Chapter 1").
2. `manifestService.createProject(projectType, source, metadata)` with
   `projectType` from the tag toggle; write the epub to `source/exported.epub`.
3. Build `render/plan.json` (splitForTts over chapter text + chapter map).
4. Navigate the reader to `p:<projectId>` and pop the **mode picker** (Phase F).

## Phase E — Persistent BookRenderService (main process)
*the unified live renderer — the heart of the feature*

New `electron/book-render-service.ts`:
- **Render loop:** low concurrency (1–2; Orpheus batch width 4 available but keep
  memory low), call `getActiveEngine().generateSentence(text, index, settings)`,
  wrap PCM16→WAV, write `render/sentences/<index>.wav`, record
  `durations[index]`, set `coverage[index]=true`, **release the buffer**. Owns
  engine start/stop lifecycle.
- **Ordering (forward-then-wrap):** order = `[playhead … end]` then
  `[0 … playhead-1]`, skipping covered indices. Re-derived whenever the reader
  reports a new playhead → satisfies "start halfway, then loop back to the front."
- **Resumable:** on start, load `state.json`, skip already-covered indices.
- **Endpoints:**
  - `POST /api/render/start` `{projectId, mode:'full'|'follow', startIndex}`
  - `GET /api/render/status?projectId` → `{coverage, durations, cursor}`
    (reader shows buffering until the next needed index is `true`)
  - `GET /api/render/sentence?projectId&index` → the rendered WAV bytes
  - `POST /api/render/playhead` `{projectId, index}` → reprioritise
  - readiness push over the existing reader WS (or short poll of `/status`).

## Phase F — Reader playback modes
*follow-along is mostly the existing service; full-book reads the disk cache*

On reader open, pick:
- **Follow along** (moving ±45 s): existing `reader-playback.service` WS
  streaming, bounded — keep ≤45 s ahead + ≤45 s behind the playhead, evict the
  rest, **re-seed on jump** (clear + restart the window at the new sentence).
  Ephemeral; no disk. This is tuning the ported read-ahead, not new transport.
- **TTS entire book**: kick `POST /api/render/start {mode:'full'}`; reader plays
  from `/api/render/sentence`, shows a buffering ring until the next index is
  ready, and reports playhead so the renderer prioritises around it. Continues in
  the background after the reader closes.
- Sentence-tap-to-start already works (`seekToSentence`); in full mode a tap also
  moves the render playhead.

## Phase G — Completion → m4b + audiobook page

- When `coverage` is all-true: assemble.
- **Recommended: direct ffmpeg assembler** (we own the sentence set + chapter map
  + durations): concat WAVs per chapter → AAC/m4b with chapter metadata + cover,
  and emit `output/<title>.vtt` from the cumulative durations. Cleaner than
  reconstructing an e2a session-state for `--sentences_dir`, and the VTT makes the
  finished audiobook **reader-synced for free** in the existing player.
  *(Fallback: reuse `runAssembly` with a synthesised session-state + `--sentences_dir`.)*
- `manifestService.registerAudiobookOutput(m4bPath)` → pairs the sibling VTT,
  writes `outputs.audiobook` → appears on **Bookshelf audiobooks + Studio grid**.

---

## Build order & checkpoints

1. **B + D (flow editor → epub → project → reader open)** — smallest end-to-end
   slice; also lands URL/epub/txt import + the Article/Ebook tag + retires the old
   article flow. Testable without any renderer changes (reader already plays epub
   via follow-along).
2. **F follow-along ±45 s** — bound the existing service; independently testable.
3. **E + G (persistent renderer → m4b)** — the big new backend; full-book mode +
   audiobook output.
4. **C (PDF page editor)** — most UI, last; reuses D's export.

Each is a committable, testable unit.

## Open risks
- **Engine lifecycle under background render** — `generateSentence` needs an
  active session; the service must start/keep/stop the engine without colliding
  with an interactive follow-along session or a batch queue job. May need a
  render-mutex around the shared GPU.
- **Byte format** — confirm streaming `generateSentence` returns PCM16 (wrap→WAV)
  vs already-WAV before writing.
- **ffmpeg-direct vs e2a assembly** — pick in Phase G; ffmpeg-direct recommended.
