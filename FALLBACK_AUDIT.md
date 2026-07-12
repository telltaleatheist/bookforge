# BookForge Fallback / Stub / Bug Audit

**Date:** 2026-07-11
**Method:** Six parallel code-reading passes over the TTS pipeline, AI/translation, manifest/library, document processing, main-process/IPC, and Angular services. Definition used (Owen's words): *"a fallback is a code path that, when something fails, does something unexpected rather than providing an error so the user knows what went wrong — or that anything is going wrong at all."*
**Status:** Documented only — nothing fixed. Review list.

Total: ~95 findings. ~16 HIGH.

---

## Systemic themes (fix the root, not the leaves)

1. **The completeness gate checks file EXISTENCE, not content.** `findMissingSentenceFiles` / reassembly pre-validation only ask "does a file exist for each sentence?" So any code that writes a **0.1 s silent clip** for a failed generation (Orpheus, Voxtral, F5) sails through the gate. This is the exact class as the `_save_audio` silence band-aid you found — the band-aid exists *because* the gate can't see empty content. **Fix the gate to validate content, and stop substituting silence for failures.** (A#4, A#11, C#12)

2. **`modifyManifest()` returns `{success:false}` on a failed write instead of throwing.** A whole cluster of IPC handlers call it, ignore the result, and report success — so a busy/synced-drive write (EBUSY) half-applies while the UI says "done." `variant:delete`/`variant:add` were hardened against this; their siblings were not. **Make `modifyManifest` throw, or force every caller to check.** (E#2–6, C#1)

3. **The "success with 0 changes" ghost lives in translation & analysis.** The *cleanup* pipeline was already hardened (visible skip accounting, `MAX_FALLBACK_COUNT` abort, no `|| text`). Translation and analysis never got that treatment: on a failed/empty LLM call they silently ship the **original untranslated text** or **`[]` "no problems found"** as success. (B#1, B#2, B#5)

4. **`SubprocessPipe`'s success flag is silently discarded.** `if (proc_pipe:)` tests a constructed object, which is always truthy — every ffmpeg concat / export / normalize reports success regardless of ffmpeg's exit code. This single bug neuters the success check across all of assembly. (A#1)

5. **"Corrupt JSON → reset to `{}` → next write overwrites it" recurs in five places** — tool-paths, ebook-library tag cache, component `installed.json`, `bookshelf.json` (a **security** control), managed-bins. A transient partial read silently and permanently destroys real config. (C#5, C#6, C#13, E#1, E#19)

6. **Security: the bookshelf access-key gate fails OPEN.** Corrupt config → empty key → whole library served to the network. Highest-urgency single item. (E#1)

---

## HIGH severity

### TTS generation & assembly
- **A1 — SubprocessPipe return value discarded; every ffmpeg step reports success on failure.** `ebook2audiobook/lib/classes/subprocess_pipe.py:6-17` (consumers `core.py:2600,2388`, `common/audio.py:143`). `_run_process()` returns True/False but is never stored; `if proc_pipe:` is always truthy. A failed concat/normalize/export returns success with a missing/corrupt file. *Single most damaging finding.*
- **A2 — `combine_audio_chapters` assembles whatever chapter FLACs exist; no completeness check.** `ebook2audiobook/lib/core.py:2429-2456`. Globs `*.flac`, never compares to expected chapter count. Combined with A1, drops whole chapters while returning `success:True`. Only guard fires when *all* chapters are absent.
- **A3 — Parallel assembly salvages a stale/partial M4B when e2a exits non-zero.** `electron/parallel-tts-bridge.ts:3778-3820`. On failed assembly it picks the most-recently-modified `.m4b` in `outputDir` (likely the *previous* run) and resolves success with it. Contrast `reassembly-bridge.ts`, which stages+verifies.
- **A4 — Orpheus/Voxtral substitute 0.1 s silence for a failed generation and save it as a valid sentence.** `orpheus.py:625-626,969-975,1445-1446`; `voxtral.py:254-255`. `convert()`'s `len==0` check passes the blip; the file exists, so the completeness gate passes it. Sentence's words silently dropped. **This is the epicenter — same class as the `_save_audio` band-aid.**

### AI cleanup / translation
- **B1 — `translateEpub` silently ships untranslated chunks as a successful translation.** `electron/translation-bridge.ts:644-662`. Any error outside a small whitelist → original source chunk pushed, loop continues, `{success:true}`. No skipped-chunks artifact, no threshold. A Claude content refusal lands here. 40% untranslated book reports full success.
- **B2 — `translateWithLocal` falls back to the untranslated original on empty output.** `electron/translation-bridge.ts:399`. `... || text` returns source text as "translation" (every other provider was hardened to throw). Also defeats retry.
- **B3 — Batch translation failure injects spoken placeholder text and reports success.** `electron/bilingual-processor.ts:977-988`. Emits `[Translation failed: …]` as the target; not a recognized skip marker, so it's written into the EPUB and **spoken by TTS**.
- **B4 — Single-sentence translate returns first line or a spoken placeholder.** `electron/bilingual-processor.ts:875-878`. `lines[0] || "[Translation failed for: …]"` — narrates the placeholder, and blindly trusts line 0 (preamble becomes the translation).

### Document processing
- **D1 — Redaction/export writes a corrupt sub-1 KB PDF but returns success.** `electron/pdf-bridge.ts:377-382,483-488`. Logs "suspiciously small" then writes the file and returns normally. Whole-book content silently gone, reported as a successful export.
- **D2 — Apple Vision batch OCR silently skips pages whose image is missing.** `electron/plugins/builtin/apple-vision-ocr/apple-vision-ocr-plugin.ts:390-393`. Missing input → `continue`; result array shorter than page list, holes treated as blank.
- **D3 — Page-load memory error substitutes default Letter dimensions.** `electron/pdf-analyzer.ts:465-478,713-720`. Fabricated `612×792` geometry → all header/footer/region math for that page is wrong; text silently misplaced.
- **D4 — Web fetch accepts partial page content after load timeout without flagging.** `electron/web-fetch-bridge.ts:345-357,458-461,528-533`. Timeout/unsolved-captcha "proceeds anyway"; only gate is `length<100`. Half-loaded article saved as success and turned into an audiobook.

### Manifest / library
- **C1 — `archiveFile()` reports success even when the manifest write fails.** `electron/manifest-service.ts:977-984`. Copies file to `archive/`, discards `modifyManifest` result, returns `{success:true}`. On EBUSY the file lands but the entry never persists → orphan, no error. *Your exact scar.*
- **C2 — `listProjects()` silently drops any project whose `manifest.json` won't parse.** `electron/manifest-service.ts:696-699`. One corrupt/half-written manifest → the whole book vanishes from the shelf with only an invisible `console.warn`.

### Main process / IPC
- **E1 — Corrupted `bookshelf.json` disables the access-key gate (fails OPEN). [SECURITY]** `electron/bookshelf-server.ts:515-518` (gate `284-292`). Config resets to `{}`, key vanishes, `/api` middleware treats missing key as "wide open" → entire library served to anyone on the network.
- **E2 — `audiobook:delete-output` unlinks the m4b/VTT without checking the manifest write.** `electron/main.ts:6941-6972`. `modifyManifest` result discarded, files unlinked unconditionally → half-applied delete (file gone, entry remains). Sibling `variant:delete` (6926) was hardened; this was missed.

### Frontend
- **F1 — Diff computation timeout/error silently shows "No changes."** `src/app/features/audiobook/services/diff.service.ts:152-176`. Resolves `[]` on 30 s timeout, worker reject, and outer catch; `errorSubject` never set. **A reviewer approves unreviewed AI cleanup believing nothing changed** when the comparison actually failed.
- **F2 — `StudioService.loadBooks/loadArticles` swallow load failures → stale-but-happy grid.** `src/app/features/studio/services/studio.service.ts:127-129,341-343,354-356,432-434`. Inner catch only logs; `loadAll`'s error handler never sees it. A backend/IPC failure reads as "you have no books."

---

## MED severity

### TTS generation & assembly
- **A5 — Worker reports `success:True` with unrendered sentences ("warn and continue").** `ebook2audiobook/bookforge_ext/parallel/worker_core.py:375-378,427-431,446-455`. The 2026-07-05 poisoned-CUDA shape; caught by the bridge gate but the worker itself lies.
- **A6 — Assembly auto-detects "completed" chapters and silently produces a PARTIAL book.** `lib/core.py:3819-3841`. When `--chapters` isn't passed (parallel + reassembly paths), assembles only "completed" chapters, tags filename "(Partial …)", returns success.
- **A7 — Reassembly pre-validation is conditional — skipped when session-state lacks fields.** `electron/reassembly-bridge.ts:888-912`. Missing/unreadable `session-state.json` → the gap check is silently skipped.
- **A8 — RVC-enhanced sentence set is never completeness-checked before assembly.** `electron/parallel-tts-bridge.ts:3027-3106`; `reassembly-bridge.ts:938-986`. Gate runs on the pre-RVC dir; RVC writes a new dir that's assembled unverified.
- **A9 — `export_audio` hard-requires the VTT, but VTT failure is only a warning.** `lib/core.py:2413-2416` vs `3864-3869`. Contradiction: a VTT failure the code claims to tolerate actually crashes export via `shutil.move`, failing the whole audiobook as a generic "Export failed."
- **A10 — `get_audiolist_duration` swallows all errors and returns 0.0 durations.** `lib/classes/tts_engines/common/audio.py:107-120`. Missing mediainfo → all durations 0.0 → VTT cues collapse to `00:00:00.000`.
- **A11 — Voxtral/F5 replace a fully-trimmed clip with 0.1 s silence and save as success.** `voxtral.py:306-307`; `f5.py:249-250`. Same silence-masks-failure class as A4.
- **A12 — XTTS `convert` returns True without writing a file when all subparts are skipped.** `xtts.py:182-192`. Punctuation-only non-empty sentence → no file, `return True`. Gate then flags a permanent un-assemblable gap with no clear cause.

### AI cleanup / analysis
- **B5 — Book analysis treats empty/failed AI responses as "no problems found."** `electron/book-analysis.ts:349,390,436`. `|| '[]'` — a hung model / VRAM overflow / refusal reads as "no manipulation detected." Dangerous false negative for an analysis tool.
- **B6 — Analysis JSON parse failure swallowed → chunk yields zero flags.** `electron/book-analysis.ts:202-224`. Prose/markdown from small models → `return []`, chunk scored clean, no failure count surfaced.
- **B7 — Analysis per-chunk error logged and skipped; job still reports success.** `electron/book-analysis.ts:678-684`. No per-chunk failure counter/threshold; report silently under-represents the book.
- **B8 — mono-translation keeps untranslated paragraph after retry, silently.** `electron/ll-jobs.ts:1659-1667`. Missing paragraph → "keeping original" pushes source text into the "translated" EPUB.
- **B9 — LL translation truncates mismatched source/target chapters, hiding lost sentences.** `electron/ll-jobs.ts:1250-1273`. Per-chapter `slice(minLen)` discards extra sentences and can misalign pairs; the final-validation throw is dead because per-chapter truncation makes totals always match.
- **B10 — Batch translation over-count silently accepted as exact.** `electron/bilingual-processor.ts:842-846`. More lines than expected → take first N, `{exact:true}` (skips retry) → later sentences pair with wrong source.
- **B11 — `checkClaudeConnection`/`checkOpenAIConnection` are permanent stubs in a live dispatch path.** `electron/ai-bridge.ts:1123-1131,1256-1263`. Always return `{available:false}`; cloud providers appear permanently unavailable through `checkProviderConnection`.

### Manifest / library / components
- **C3 — `getLibraryBasePath()` falls back to `~/Documents/BookForge` when unset.** `electron/manifest-service.ts:84-90`. Startup race / failed settings load → every manifest op targets the wrong location (library "vanishes" or ghost project in Documents).
- **C4 — `renameProjectFolder` swallows the post-rename manifest-update failure.** `electron/manifest-service.ts:843-856`. Folder renamed, `projectId` update fails silently → later ops recreate a ghost folder at the old path, splitting the project.
- **C5 — Corrupt `tool-paths.json` is silently discarded AND then overwritten.** `electron/tool-paths.ts:116-131,158-171`. Transient read error → `config={}` → next `updateConfig` persists empty → all conda/ffmpeg/WSL/HF config permanently destroyed.
- **C6 — ebook-library metadata cache resets to `{}` on corruption — silently loses user tags.** `electron/ebook-library.ts:196-212,1242-1250`. User tags live only in this cache; a corrupt `metadata.json` drops every tag, next save persists the loss.
- **C7 — diff-cache path derived via `String.replace('.epub', …)` — clobber risk.** `electron/diff-cache.ts:90,140,201,261,287,310`. `.EPUB`/extension-less input → `replace` no-ops → `diffPath === cleanedEpubPath` → **overwrites the cleaned EPUB with diff JSON.** Latent today.
- **C8 — `migrateAudiobookFolder` records a nonexistent path; legacy folders never migrated.** `electron/manifest-migration.ts:431 vs 463; 144-168`. Records `output.epub` (never written); `audiobookFolders`/`articleFolders` hardcoded `[]` so those migrations are dead code.
- **C9 — `getDefaultE2aTmpPath` falls back to `<e2a>/tmp` when the scratch volume is offline.** `electron/e2a-paths.ts:112-122`. Job writes session to volatile temp → breaks the resume-cache binding; a later "Continue" won't find the session.
- **C10 — book-render assembly failure leaves the job stalled at 100% with no error set.** `electron/book-render-service.ts:481-486`. ffmpeg fails → catch only logs; `done=false, assembling=false, error=undefined` → book stuck at 100% forever.
- **C11 — book-render registers the audiobook even when transcript embed fails.** `electron/book-render-service.ts:468-476`. Registered as finished with no embedded transcript → synced-text playback silently broken. (Same tolerant pattern at `manifest-migration.ts:322-326,420-424`.)
- **C12 — book-render substitutes 0.3 s silence for a persistently-failing sentence.** `electron/book-render-service.ts:383-390`. Silent gap in the finished m4b, only a `console.warn`. (Same class as A4/A11.)
- **C13 — Corrupt `components/installed.json` reads as "nothing installed" and can be overwritten.** `electron/components/component-manager.ts:90-104,125-129`. First `putRecord` after corruption permanently overwrites, discarding manually-located external paths.

### Document processing
- **D5 — Image extraction failure swallowed — export proceeds without images.** `electron/pdf-analyzer.ts:558-560,821-823`.
- **D6 — EPUB nav-title regex misses anchors with nested tags → default "Chapter N".** `electron/epub-processor.ts:349,577`. `<a><span>Title</span></a>` → real titles replaced by "Chapter 1/2/3…".
- **D7 — EPUB nav/ncx read errors silently swallowed → all chapters keep default titles.** `electron/epub-processor.ts:299-301,309-311` (empty `catch {}`). Can't distinguish "no nav" from "nav present but a path bug broke reading."
- **D8 — EPUB chapters silently dropped when a spine item has non-standard/missing media-type.** `electron/epub-processor.ts:562-583`. Malformed EPUB loses chapters, reported as a complete parse.
- **D9 — EPUB metadata defaults mask missing title/author/language.** `electron/epub-processor.ts:488-491`. `|| 'Untitled'/'Unknown'/'en'`. *UNSURE — verify intended UX.*
- **D10 — Apple Vision reports confidence 1.0 for an empty/blank OCR result.** `ocr-apple-vision.py:80`. `... if text_lines else 1.0` → blank page reads as perfectly OCR'd.
- **D11 — Tesseract deskew returns angle 0 on failure (indistinguishable from "straight").** `electron/ocr-service.ts:460-464,515-517`. `getAvailableLanguages` returns `['eng']` on failure (masks missing Tesseract). *UNSURE how callers use confidence.*
- **D12 — ffmpeg metadata remux timeout resolves as SUCCESS (silent no-op).** `electron/metadata-tools.ts:177-183`. Hung-and-killed remux reports success while changing nothing (the "success with 0 changes" ghost). Abort/user-cancel resolving is fine; timeout is not.
- **D13 — PDF bookmarks/TOC silently dropped on any bookmark error.** `electron/pdf-bridge.ts:586-589`. Exported PDF has no TOC, export still succeeds.
- **D14 — Web-fetch text extraction falls back to a raw body dump when no paragraphs found.** `electron/web-fetch-bridge.ts:1103-1109`. One giant blob bypasses per-paragraph boilerplate filtering → nav/menus/footers narrated as the article.
- **D15 — mutool stext parsing assumes `quad="…"` on every `<char>` — silent empty output otherwise.** `electron/mutool-bridge.ts:591,735`. A mutool build emitting a different geometry attr → zero extracted text, PDF treated as text-less. *UNSURE — verify bundled mutool always emits `quad`.*
- **D16 — OCR (node-tesseract) hardcodes `confidence = 0`.** `electron/ocr-service.ts:146-150`. Garbage OCR indistinguishable from clean.

### Main process / IPC
- **E3 — `variant:set-primary` returns success without checking the write.** `electron/main.ts:6974-6987`. Also no-ops silently on a bad `variantId`.
- **E4 — `variant:pull-metadata` returns success without checking the write.** `electron/main.ts:6991`.
- **E5 — `variant:send-to-pipeline` reports success even if the source-pointer write failed.** `electron/main.ts:7005`. Editor opens with stale `source.type/originalFilename` → later step reads the wrong source.
- **E6 — `archive:migrate-from-library` counts "migrated" without verifying the write.** `electron/main.ts:7203,~7257`.
- **E7 — `project:update-metadata` reports success while cover/metadata embedding silently fails.** `electron/main.ts:1763,1819,1837`. New cover never embedded into the primary EPUB / shelf M4B; library keeps showing the old cover.
- **E8 — `audiobook:extract-epub-metadata` falls back to filename parsing but returns `success:true`.** `electron/main.ts:6443-6456`. Unreadable EPUB → guessed title/author, no cover, presented as clean success.
- **E9 — `pdf:get-spans-for-block` returns `{success:true, data:[]}` when the worker lost its span cache.** `electron/main.ts:1117`. Renderer told the block legitimately has zero spans → highlighting/redaction/OCR mapping silently no-ops.
- **E10 — `pdf:assemble-from-images` swallows the error and returns `null`.** `electron/main.ts:1217-1224`. Unlike every sibling (`{success:false,error}`).
- **E11 — `fs:list-directory` returns `[]` on any read failure.** `electron/main.ts:1346`. Permissions error / offline drive presents as "empty directory."
- **E12 — `chapter-recovery:probe-chapters` returns `[]` on ffprobe failure.** `electron/main.ts:8916-8923`. Missing/crashing ffprobe on a file with real embedded chapters → "no chapters," silent fallback to wrong EPUB fuzzy markers.
- **E13 — `sentence-cache:cache-audio` sets `hasAudio=true` even when zero `.flac` were copied.** `electron/main.ts:9856`. Empty TTS output → cache marked as having audio → `run-assembly` passes its existence check and assembles an empty/broken bilingual book.
- **E14 — `sentence-cache:run-assembly` silently ignores `outputFormat` and languages past the first two.** `electron/main.ts:9888-9925` (`// TODO` at 9912). mp3 request silently produces m4b; 3+ languages silently assembles only the first two. *(stub + silent-fallback)*

### Frontend
- **F3 — `StudioService.updateArticle` applies optimistic local edit before confirming save.** `src/app/features/studio/services/studio.service.ts:623-645`. On EBUSY the UI shows edited/saved; reverts on next reload with no indication.
- **F4 — `ElectronService` chapter-detection methods drop backend errors, return empty.** `src/app/core/services/electron.service.ts:946-1019` (extractOutline, outlineToChapters, detectChapters, detectChaptersFromExamples, mapTocEntries, splitTocBlocks, mapTitlesToChapters). Real failure indistinguishable from "no chapters found."
- **F5 — PlayView: EPUB parse failure rendered as "No readable text found."** `src/app/features/audiobook/components/play-view/play-view.component.ts:1763-1794`.
- **F6 — PlayView.startStreaming: voice-load failure silently no-ops Play.** `src/app/features/audiobook/components/play-view/play-view.component.ts:1818-1822`. Press Play, nothing happens, no message.
- **F7 — `DiffService.loadChapterWithCache` returns null on IPC failure without setting error.** `src/app/features/audiobook/services/diff.service.ts:846-887`.

---

## LOW severity & UNSURE

### TTS
- **A13 — `applyM4bMetadata` swallows failure as success.** `electron/reassembly-bridge.ts:2013-2016`. *UNSURE — "non-critical" but hides a real failure.*
- **A14 — `generate_ffmpeg_metadata` defaults an unparseable/absent publish date to the current year.** `lib/core.py:2263-2272`.
- **A15 — `normalize_audio` else-branch references an undefined variable `e`.** `lib/classes/tts_engines/common/audio.py:145-148`. NameError if reached; unreachable today only because of the A1 truthiness bug.
- **A16 — `_build_vtt_file` per-file duration defaults to 0.0.** `lib/classes/tts_engines/common/utils.py:650`. Coupled to A10.

### AI / translation
- **B12 — Non-`CLEANUP_PROMPTS` languages silently get the English cleanup prompt.** `electron/ai-cleanup-prompts.ts:438-446` + `ai-bridge.ts:765-777`. e.g. Hungarian cleaned with English number-to-words rules. *UNSURE — verify intent.*
- **B13 — Bilingual `cleanupText` has no fallback threshold (recorded, but never aborts).** `electron/bilingual-processor.ts:445-532`. A caller ignoring `skippedChunks` sees a clean pass.
- **B14 — Empty-content masking in bilingual `callOpenAI`/`callClaude` hides `finish_reason`.** `electron/bilingual-processor.ts:227,266`. Feeds the B3/B4 placeholder path.
- **B15 — Deprecated bilingual-EPUB path (`generateBilingualEpub`) still wired into `processBilingualText`.** `electron/bilingual-processor.ts:1346-1438` (called at 1769). *Verify it's dead.*

### Manifest / library
- **C14 — Tool path getters fall back to bare command names / guessed install dirs.** `electron/tool-paths.ts:331,377,421,455`. Deferred cryptic spawn failure (mitigated by `getToolStatus` reporting `detected:false`). *UNSURE.*
- **C15 — `readMetadata` silently falls back to filename parsing.** `electron/ebook-library.ts:297-318`. Masks "Calibre not installed" / "file corrupt." *UNSURE — likely fine for a display cache.*
- **C16 — `writeDiffCacheAtomic` uses a fixed shared `.tmp` name with no cleanup on failure.** `electron/diff-cache.ts:23-27`. Low real risk (sequential writes).

### Document processing
- **D17 — JWPUB unknown MEPS language silently becomes English.** `electron/jwpub-converter.ts:643`.
- **D18 — Scanned/text-less PDF analyzed to zero blocks with no signal.** `electron/pdf-analyzer.ts:492-568`. Looks "empty" rather than "needs OCR." *UNSURE — may be by design.*
- **D19 — Overlay background-color sampling failure defaults to white.** `electron/pdf-bridge.ts:439-444`. Cosmetic (visible white box on non-white pages).

### Main process / IPC
- **E15 — `doRuntimeSetup` transitions to "ready" even if the TTS API server failed to start.** `electron/main.ts:154,102`. App says "Ready" but phone/bookshelf clients can't reach TTS.
- **E16 — `sentence-cache:list` silently drops corrupt cache files.** `electron/main.ts:9653`. *UNSURE — may be acceptable for a listing endpoint.*
- **E17 — `sentence-cache:run-tts` registers no cancellation entry.** `electron/main.ts:9757` (contrast `queue:run-tts-conversion` at 8543). Cancel could report "Job not found" while TTS keeps running. *UNSURE.*
- **E18 — pdf worker method name casing `'analyzesamples'`.** `electron/main.ts:1083`. If the worker dispatches by exact name (`analyzeSamples`), the feature always throws. *UNSURE — verify worker export name.*
- **E19 — `managed-bins` `readState()` returns `{}` on a corrupt `state.json`.** `electron/update/managed-bins.ts:64-70`. Installed binaries re-download. Low impact.

### Frontend
- **F8 — DiffService: empty diff on a non-empty chapter only warns to console.** `src/app/features/audiobook/services/diff.service.ts:541-543`. Downstream symptom of F1.
- **F9 — StudioService dead methods (`mapArticleStatus`, `translatePath`).** `src/app/features/studio/services/studio.service.ts:451,874`. *(stub — grep-confirmed unreferenced.)*
- **F10 — `detectRecommendedWorkerCount` failure silently defaults to 2 workers.** `src/app/features/queue/services/queue.service.ts:2784-2790`.
- **F11 — `PdfEditorStateService.updateThreshold` silently no-ops on a malformed path.** `src/app/features/pdf-picker/services/editor-state.service.ts:1273-1282`. Still marks the doc dirty.
- **F12 — DiffViewComponent double-load race (constructor effect + ngOnInit fallback).** `src/app/features/audiobook/components/diff-view/diff-view.component.ts:747-759,902-908`. Timing-dependent duplicate load.

---

## Stubs (scaffolded but not built out)

- **B11 — `checkClaudeConnection`/`checkOpenAIConnection`** permanently return unavailable. `electron/ai-bridge.ts:1123-1131,1256-1263`. *(also HIGH-adjacent above)*
- **E14 — Multi-language / `outputFormat` assembly** — `// TODO` at `electron/main.ts:9912`; unsupported configs silently degrade instead of erroring.
- **C8 — Legacy audiobook/article folder migration** — `migrateAudiobookFolder`/`migrateArticleProject` never invoked (`audiobookFolders`/`articleFolders` hardcoded `[]`). `electron/manifest-migration.ts:144-168`.
- **F9 — `mapArticleStatus`, `translatePath`** — defined, never called. `studio.service.ts:451,874`.
- **B15 — `generateBilingualEpub` / `processBilingualText`** — `@deprecated` but still reachable. `bilingual-processor.ts:1346-1438`.
- Minor placeholder returns noted out of scope: `pdf-analyzer.ts:4299-4300` (`preceded_by/followed_by: null // TODO`), `web-fetch-bridge.ts:1047` (empty `catch {}`).

---

## Good patterns already in place (the models to copy)

- **`ai-bridge.ts` cleanup path** — visible `[SKIP]` trapdoor (no `|| text`), `applyOutputSafeguards` skip accounting, `checkFallbackThreshold` abort, writes `skipped-chunks.json`. *This is the template translation/analysis should follow.*
- **`parallel-tts-bridge.ts` `findMissingSentenceFiles` + pre-assembly gate** — fails loudly, treats "can't verify" as failure. (Weakness: it checks existence, not content — see theme #1.)
- **`reassembly-bridge.ts` staging→promote** — never reports success on a failed promote; preserves staging for salvage.
- **`variant:delete`/`variant:add`** (`main.ts:6926,6755`) — correctly check `saved?.success` and clean up orphans. The reference the unchecked handlers should match.
- **`orpheus.py` `_save_audio`** deliberately removed its trailing-silence trim; `_redistribute_codes` raises `TokenStreamMisaligned`; fatal-CUDA re-raise — good loud-failure paths.
- **`e2a-paths.resolveCondaEnv`/`getEnvPathForEngine`**, **`catalog-service`** (last-good + allowlist + schema floors), **`update/*`** (sha256-verified, fail-closed), **`llama-bridge.generate`** (budget-exhaustion vs genuine-empty) — all fail loudly by design.

---

## Suggested fix ordering

1. **E1** (security, fail-open) — immediate.
2. **A1 + A2 + A4** — the assembly/silence root that produced the band-aid you found. Fix the completeness gate to validate content, expose SubprocessPipe's result, verify chapter set.
3. **`modifyManifest` throwing + the unchecked-write cluster** (C1, E2–E7) — one root, batch fix.
4. **Translation/analysis "success with 0 changes"** (B1–B7) — port the cleanup pipeline's hardening.
5. **Corrupt-JSON-resets-to-`{}`** family (C5, C6, C13, E19) — back up + surface instead of overwrite.
6. **F1** — a correctness hazard for the human reviewer, cheap to fix.
7. Everything else by area.


---
---

# ADDENDUM — Second-pass review (2026-07-12, Fable)

Four parallel passes: (1) adversarial verification of every HIGH finding above,
(2) sweep of areas the first audit never covered (cli/, electron/scripts/*.py,
tts-api-server.ts), (3) the two giant frontend files hunter F skipped,
(4) the ~80% of e2a core.py outside assembly + session/resume code.

## Part 1 — Verification of the original HIGH findings

**Result: zero outright false positives. 14 of 16 CONFIRMED, 2 already fixed
correctly on `fix/tier1-safe-fallbacks`, 1 weakened (still real).**

| ID | Verdict | Notes |
|---|---|---|
| A1 | CONFIRMED | Consumers' real lines: `core.py:2411` (export), `core.py:2623` (assemble), `audio.py:143`. export_audio has a secondary exists&&size>0 guard — catches a MISSING file, not a partial/corrupt one; assemble/normalize have no guard at all. |
| A2 | CONFIRMED | Real lines: `core.py:2452-2459` + `2477-2479` (audit's 2429 range was cover-embed code). |
| A3 | CONFIRMED | Salvage-on-failure branch is `parallel-tts-bridge.ts:3822-3859`. **Bonus finding:** the success branch (3778-3820) ALSO picks most-recent m4b and has a hardcoded `audiobook.m4b` fallback at 3788. No mtime-vs-job-start check anywhere, so a previous run's file qualifies. |
| A4 | CONFIRMED (Voxtral) / WEAKENED (Orpheus) | Orpheus now has a `_guard_truncation` backstop (`orpheus.py:1124-1153`, applied on all convert paths) the hunter missed — BUT it only fires for text >150 chars, and a failed re-render "accepts and warns," saving the blip. Short sentences and double-failures still ship silence as success. Voxtral fully confirmed. |
| B1-B4 | CONFIRMED | All four verified line-exact. Grep confirms nothing downstream recognizes the `[Translation failed…]` placeholder — it reaches EPUB/TTS. |
| D1-D4 | CONFIRMED | All verified line-exact. |
| C1 | ALREADY-FIXED-CORRECTLY | Fix at `manifest-service.ts:983-995` (commit 1f3eecc). |
| C2 | CONFIRMED | Still unfixed. |
| E1 | CONFIRMED | Fail-open access gate is real. Highest urgency unchanged. |
| E2 | ALREADY-FIXED-CORRECTLY | Fixed incl. saved-before-target ordering (commit dbeb4ef). |
| F1, F2 | CONFIRMED | All three diff-service empty-resolve paths verified; studio loaders swallow before loadAll's catch can fire. |

## Part 2 — NEW findings (areas the first audit never covered)

### G — e2a core.py remainder + session/resume (NEW)

- **[HIGH] G1 — get_chapters silently truncates the book on any None doc.** `e2a lib/core.py:797-801`. `filter_chapter` returns None for errors AND image-only/decorative pages; the loop `break`s and returns the partial chapter list as SUCCESS — everything after the bad doc silently missing.
- **[HIGH] G2 — year2words returns False into re.sub → chapter dies → book truncated.** `core.py:1651-1654` (used at 1121, 1154, 1160). One un-convertible year token → TypeError inside re.sub → swallowed by filter_chapter's blanket except → None → G1's break. One bad year amputates the rest of the book.
- **[HIGH] G3 — Corrupt chapter-cache JSON on resume → silent re-split → misaligned audio.** `core.py:495-501` (`load_json_chapters` → `[]`) consumed at 2927, 2961-2963. Corrupt JSON reads as "no chapters"; get_chapters re-runs; the new sentence split can differ from the split the existing numbered WAVs were rendered from; resume-by-file-index pairs old audio with wrong text, zero warning.
- **[MED] G4 — Dead None-check in filter_chapter.** `core.py:1178-1183, 1540-1542`. `if sentences and len(sentences)==0:` can never be true; a None from get_sentences → TypeError → truncation chain.
- **[MED] G5 — math2words called with int in ordinal branch.** `core.py:1131-1133` passes `int(m.group(1))` where line 1128 correctly passes `m.group()` → TypeError → truncation chain (non-num2words languages).
- **[MED] G6 — get_date_entities failure indistinguishable from "no dates".** `core.py:1552-1563` returns False on NER crash; caller's `if date_spans:` silently takes the degraded branch.
- **[MED] G7 — language_iso1 silently falls back to 'en' (twice).** `bookforge_ext/parallel/session.py:379, 936`. Any Lang() error → all normalization runs in English for a non-English book.
- **[MED] G8 — Bilingual assembly M4B failure silently downgrades to FLAC, reports success.** `bookforge_ext/parallel/bilingual.py:648-649` (+ `except: pass` cleanup at 646).
- **[MED] G9 — load_session_state: corrupt state file treated as "no session".** `session.py:110-129`. Corrupt/truncated session-state.json → None → fresh start, resume state silently discarded. save_session_state failure (105-107) is print-only.
- **[LOW] G10 — normalize_text emoji strip is a no-op.** `core.py:2009` — `emoji_pattern.sub('', text)` result never assigned; emojis reach TTS.
- **[LOW] G11 — TOC failure degrades to numberless titles (alert shown).** `core.py:750-753`.
- Clean: tts_manager.py, tts_registry.py (explicit raises), voice_extractor.py (error tuples propagate), bookforge_ext hooks/handlers/args, download_model.py.

### H — Giant frontend files (pdf-picker 11.5k lines, ll-wizard 5.9k — skipped by first audit)

- **[HIGH] H1 — "Deskew" is a stub that reports success.** `pdf-picker.component.ts:10057` — detects angle via Tesseract, hits `// TODO: Apply the rotation`, never rotates; `deskewAllPages()` still pops "Deskew Complete" success alert (10031-10035).
- **[HIGH] H2 — Queue-add failure silent → half-queued pipeline, retry double-queues.** `ll-wizard.component.ts:5401, 5790`. Mid-sequence addJob throw → console only; earlier jobs ARE queued; button resets as if nothing happened.
- **[HIGH] H3 — Closing a background tab silently discards unsaved changes.** `pdf-picker.component.ts:11269-11271`. console.warn only; plain data loss.
- **[HIGH] H4 — TTS Continue silently skips a failed-resume language; queues with `epubPath: ''`.** `ll-wizard.component.ts:5072-5079`. `!resumeData?.success` → continue (language never queued, user thinks both resuming); `sourceEpubPath || ''` queues an empty path instead of erroring.
- **[MED] H5 — Background text-extraction failure leaves doc valid-looking but empty.** `pdf-picker.component.ts:4749-4754, 8488-8493` (openProject variant also silently drops deferred edits/corrections).
- **[MED] H6 — EPUB scan failures render as "no data".** `ll-wizard.component.ts:3727, 3748, 3769, 3811-3813`. EBUSY/permissions on E: looks identical to empty project; Continue offers vanish.
- **[MED] H7 — Partial-session scan errors hide resumable work.** `ll-wizard.component.ts:4329-4331, 4336-4338`. Continue button simply doesn't appear for a 6-hour partial render.
- **[MED] H8 — Continue pre-fill silently falls back to stock voice on settings-read failure.** `ll-wizard.component.ts:4397, 4403-4405` — contradicts the code's own "never a stock default" comment at 5088.
- **[MED] H9 — Re-categorize click does nothing on classifier error.** `pdf-picker.component.ts:5601-5611`.
- **[MED] H10 — savePrompt failure gives no feedback.** `ll-wizard.component.ts:4562-4574`.
- **[MED] H11 — Solo-TTS cached-partner dir defaults to empty string.** `ll-wizard.component.ts:5167` — empty string flows into assembly config; fails much later, confusingly.
- **[LOW] H12 — Import hash falls back to empty string, silently disabling dedup.** `pdf-picker.component.ts:4868`.
- **[LOW] H13 — Embedded-mode init: unhandled rejection in async setTimeout → blank editor.** `pdf-picker.component.ts:2836-2843` (dead `\\wsl$` path would trigger).
- **[LOW] H14 — Tab restore silently drops failing projects, then persists the loss.** `pdf-picker.component.ts:11450-11452`.
- Clean: export/save cluster (7361-7532, 10512-10535), copyToAudiobookQueue — proper user-facing error handling.

### I — CLI / streaming scripts / tts-api-server (never covered)

- **[HIGH] I1 — align_audiobook.py reports ok:true with an EMPTY VTT on total transcription failure.** `electron/scripts/align_audiobook.py:269-271, 392-397, 683-686`. `_transcribe_slice` swallows all exceptions → `(si, [], [])`; all-slices-failed → bare WEBVTT written, `RESULT {"ok":true,"cues":0}`. Even ONE failed slice silently deletes ~10 min from the anchor stream with no signal.
- **[HIGH] I2 — orpheus_stream.py MLX: FAILED sentence emitted as 50 ms silence with success payload.** `orpheus_stream.py:487-491, 603-606`. `None` (documented "empty OR FAILED") → `np.zeros(0.05s)` → normal batch_item. The vLLM branch correctly sends 'No audio generated' (644-645); MLX branch didn't copy it. Mid-listen content silently skipped.
- **[MED] I3 — orpheus_stream.py: unknown voice silently becomes 'leah'.** `orpheus_stream.py:269-271` + cheerful "Voice loaded: leah" status.
- **[MED] I4 — xtts_stream.py: missing ref_path silently clones ClaribelDervla under the requested voice's name.** `xtts_stream.py:209-214, 371-372, 575`; `current_voice` set to REQUESTED name (422) so the loaded reply looks correct.
- **[MED] I5 — align_audiobook.py: per-chunk align failures degrade timing silently; RESULT has no failure count.** `align_audiobook.py:125-127, 602-605, 683-686`. 100% chunk failure still emits ok:true with full cue count (all rough timing).
- **[MED] I6 — align_audiobook.py: ffprobe failure → DUR=0 via `or 0`.** `align_audiobook.py:503-505`. Everything downstream nonsense, no error naming the cause.
- **[MED] I7 — cli/orpheus-render.js: mid-render failure exits without endSession — WSL GPU worker leaked past the kill-ladder.** `cli/orpheus-render.js:95, 108-111`. catch → process.exit(1); the wsl vLLM worker (~6 GB VRAM) orphaned — the exact wedge class the TERM ladder exists to prevent. Verify orpheus-batch-render.js too.
- **[LOW] I8 — cli/electron-stub.js: getPath(unknown) → tmpdir despite the file's own no-fallbacks pledge.** `electron-stub.js:27-32`.
- **[LOW] I9 — tts-api-server.ts: corrupt config silently mints a new auth token (de-authorizes LAN clients); speak hardcodes 'en' segmentation.** `tts-api-server.ts:140-152, 419`.
- **[LOW] I10 — xtts_stream.py get_e2a_path final fallback unverified.** `xtts_stream.py:189-196`.
- Clean: transcribe_audiobook.py, write_m4b_tags.py, whisper_download.py, orpheus_download.py, cli/bookforge-tts.py (all fail loudly). renderRangeHeadless verified to have its own completeness gate.

## Revised fix ordering (supersedes the one above)

1. **E1** — security fail-open. Unchanged, still first.
2. **G1+G2+G4+G5 as ONE unit** — the filter_chapter/get_chapters truncation chain. Cheap fixes (return original string from year2words, fix the None check, pass m.group(), don't break on empty docs) that together stop books being silently amputated.
3. **A1 + A2 + A4(+Voxtral) + I2** — assembly/silence root, now including the streaming MLX silence-for-failure twin. Line numbers corrected in Part 1.
4. **G3 + G9** — resume-state integrity (corrupt cache/state must not silently reset; G3 can misalign audio to text).
5. **B1-B4 + I1 + I5** — "success with empty/original content" family: translation keep-original, spoken placeholders, empty-VTT ok:true.
6. **modifyManifest cluster remainder** (C2 + E7 etc.) and **corrupt-JSON family** (C5, C6, C13, E19, I9).
7. **H1-H4** — frontend: deskew stub honesty, queue-add rollback/alert, unsaved-changes prompt, Continue resume-failure surfacing.
8. **I7** — CLI endSession try/finally (tiny fix, prevents WSL wedges).
9. Everything else by area.


---
---

# ADDENDUM 2 — Final-wave sweep (2026-07-12, Fable)

Rule applied (Owen's sharpened definition): a designed, communicated route-around is
an expected fix and is fine; silently eating the error and continuing as though
nothing happened is a bug. Four passes: remaining frontend components, the
bookshelf phone app + iOS shell, a FULL read of queue.service + both worker
pools, and e2a auxiliary classes.

**Coverage note:** with this wave, every runtime surface has been audited except
build tooling (packaging/, scripts/), the browser extension (extension/), and
prototype/. Those were deliberately skipped as non-runtime.

## J — Remaining frontend components

- **[HIGH] J1 — Project-files browse failure renders a stage as "no files".** `src/app/features/studio/components/project-files/project-files.component.ts:660` (also 577). `catch { section.exists = false; }` — EBUSY/dead-`\\wsl$` renders identically to "stage never created"; user concludes their Source/Cleanup/TTS files are gone.
- **[HIGH] J2 — Failed version read wipes the documents list — 4 lines below a comment explaining why that's wrong.** `studio-versions.component.ts:1102`. Failed `editorGetVersions` blanks every pipeline document; `loadVariants` (786-789) explicitly refuses to do this for the same failure mode. Also no catch — a throw escapes.
- **[HIGH] J3 — "Edit this edition" silently no-ops on failure.** `studio.component.ts:2367` (also 2394, 2405, 1845). Picker closes, editor never opens, console only.
- **[MED] J4 — Article Finalize failure = spinner stops, no message.** `studio.component.ts:2449`.
- **[MED] J5 — WSL "Verify setup" does nothing on success:false reply.** `settings.component.ts:2826` (catch handles throws; error-shaped reply eaten).
- **[MED] J6 — Import Projects fails silently.** `library-view.component.ts:973` (deleteSelectedProjects right above does it correctly).
- **[MED] J7 — Dropped unsupported-format file vanishes without feedback.** `library-view.component.ts:1107` (no else for non-convertible).
- **[MED] J8 — Bookmark save/delete failures invisible.** `audiobook-player.component.ts:1065, 1078` (toast plumbing already exists).
- **[MED] J9 — Analytics load failure renders as "no analytics".** `studio.component.ts:1697`.
- **[LOW] J10 — Settings status refreshers keep stale state on success:false.** `settings.component.ts:2495, 2635, 2702-2715, 2803` (crashed bookshelf server can keep showing "running").
- **[LOW] J11 — "Delete all add-ons" fires removals without awaiting/checking.** `add-ons-panel.component.ts:749`.
- **[LOW] J12 — TTS cache read error hides Continue/Assemble buttons (borderline-designed).** `studio-versions.component.ts:1133`.
- Clean: job-progress.component, bilingual-player.component; designed route-arounds not flagged: loadVariants keep-list, background diff precompute, thumbnail/localStorage catches, settings save paths, studio export/delete paths.

## K — Bookshelf phone app + iOS shell

Overall: the most fallback-disciplined area in the codebase — catches carry rationale, several cite the no-fallbacks rule. Exceptions:

- **[HIGH] K1 — getBooks/getEbooks never check res.ok → server errors render as "no books" AND clobber the offline cache.** `projects/bookshelf/src/app/services/api.service.ts:42-54`. HTTP 500/401 with JSON body → `data.books ?? []` → empty catalog, server marked 'ok', no banner (shelf.component.ts:1771-1786) — and `persistAudiobooks()` (1788) overwrites the cold-start localStorage cache with the empty list, so books stay gone even relaunching offline. Fix: `if (!res.ok) throw` + `Array.isArray` validation (getChapters at 130-138 already has the guard pattern).
- **[HIGH] K2 — NativeFileService.getUrl swallows bridge failures → downloaded book silently streams over the network.** `native-file.service.ts:93-100`. Violates its own documented contract (49-52: "a genuine native failure THROWS"); catch→null → offline-store falls to IndexedDB where audio never lives → resolveAudioSrc falls through to the server URL. On a plane: "Audio failed to load" while a perfect on-disk copy sits unused. Fix: delete the try/catch.
- **[MED] K3 — Audio element error suppressed while loading() — load-time src failure ends spinner-off, no message.** `player.service.ts:284-286`. Load-time is exactly when src errors fire.
- **[MED] K4 — `try? setActive(true)` — AVAudioSession activation failure vanishes.** `mobile/ios/.../NativeAudioPlugin.swift:433, 443`. JS shows "playing", lock-screen may not attach, nothing logged.
- **[LOW] K5 — Offline resolve failure misdiagnosed as "Audiobook not found".** `player.service.ts:337-341` (message shown, wrong diagnosis).
- **[LOW] K6 — Swift `list` maps FS read error to `[]`, contradicting the JS contract.** `NativeFilePlugin.swift:123`. Benign today; becomes a download-record wiper if reconcile logic ever inverts.
- Clean (verified): offline download path (exemplary), shelf multi-server load, player misc catches (documented), NativeAudioPlugin error chain (modulo K3), server-config/local-library/analytics.

## L — Queue service + worker pools (full read)

- **[HIGH] L1 — Bilingual chaining validation `return` freezes the queue PERMANENTLY.** `queue.service.ts:1294-1314`. Missing sentences dir → job marked error → bare `return` from inside the post-completion try — skips the catch AND the tail (1408-1426): exclusive lane holds the finished job's id forever, `_isRunning` stays true, nothing ever runs again until app restart. The comment at 3131 ("handleJobComplete always reaches 1207-1221") is false for this path. Fix: convert the early return into a throw so the existing catch+tail run. **Worst single bug found in the entire audit.**
- **[HIGH] L2 — Inline-completing job types bypass workflow-failure cancellation → downstream jobs stuck pending, master spins forever.** `queue.service.ts:4106-4139` vs `1029-1056` (only cancel site) and `2528-2540`. rvc-enhancement, reassembly, bilingual-cleanup/-translation/-assembly, video-assembly, generate-sentences all fail by throw into runJob's catch — no sibling cancellation. Master stays 'processing' forever; flat LL workflows proceed to the next step. Fix: extract 1029-1056 into a helper called from both sites.
- **[HIGH] L3 — Failed cleanup silently feeds the RAW EPUB into translation.** `queue.service.ts:3481`. `config.cleanedEpubPath || job.epubPath` — with L2, a failed bilingual-cleanup lets translation start on the uncleaned source. Textbook eat-and-continue. Fix: throw when cleanedEpubPath is missing in a workflow that has a cleanup step.
- **[HIGH] L4 — XTTS voice-load timeout permanently leaks the worker slot → engine deadlock on CUDA.** `xtts-worker-pool.ts:631-670`. Timeout path never clears `worker.pendingRequest`/releases the slot (Orpheus's equivalent at orpheus-worker-pool.ts:518-531 does it correctly). On CUDA (1 worker): every subsequent generateSentence() hangs forever. Fix: mirror Orpheus.
- **[MED] L5 — Post-timeout responses cross-wire audio to the WRONG sentence.** `xtts-worker-pool.ts:781-807, 1032-1038`; same shape `orpheus-worker-pool.ts:668-677, 928-939`. Generation timeout dispatches the next sentence to the still-rendering worker; the late audio delivers to the new pendingRequest — sentence N's audio stored as N+1. Fix: generation-id tag echoed by the worker, or don't dispatch to a timed-out worker until its terminal message.
- **[MED] L6 — Worker crash never broadcasts engine state — UI keeps showing a running service.** `xtts-worker-pool.ts:540-562`; `orpheus-worker-pool.ts:449-465`. Last worker dies (OOM/WSL wedge) → no broadcastServiceState/play:session-ended; nav-rail stays green.
- **[MED] L7 — Corrupt saved queue silently becomes an empty queue, then auto-save destroys the evidence.** `queue.service.ts:4622-4664`. Load failure = corrupt = absent; 500ms debounced save overwrites the on-disk state with []. Interrupted-TTS wasInterrupted protection vanishes with it. Fix: rename to queue.json.corrupt + visible warning.
- **[LOW] L8 — Parallel-TTS progress handler maps 'error' phase to 'processing'.** `queue.service.ts:734-819` (reassembly/LL handlers map it correctly).
- **[LOW] L9 — Pool send() silently no-ops when stdin is gone.** `orpheus-worker-pool.ts:911-915`; `xtts-worker-pool.ts:998-1003` (caller rides out the full timeout instead of failing fast).
- **[LOW] L10 — XTTS 'stopped' response type never handled.** `xtts-worker-pool.ts:1005-1049` (interrupted generate hangs to timeout instead of resolving cancelled).
- Verified clean: double-processing guard, the 1029-1056 cancel block itself, both pools' close-handler promise resolution, Orpheus loadVoice loud rejection (explicit anti-fallback), terminal-status guards in progress handlers, wasStopped whole-queue idle (designed, WSL wedge prevention).

## M — e2a auxiliary classes

- **[HIGH] M1 — VRAMDetector silently reports SYSTEM RAM as GPU VRAM on any torch failure.** `lib/classes/vram_detector.py:167-168, 92-110`. Blanket except around the GPU probe + no else for cuda-requested-but-unavailable → 64 GB RAM machine returns free_vram_gb: 64 labeled as VRAM → vLLM sized against fantasy → OOM later with no trail. Likely hidden contributor to past mystery OOMs. Fix: raise when requested device was cuda and the probe failed.
- **[HIGH] M2 — SubprocessPipe root cause confirmed: `__init__` discards `_run_process()`'s result and stores no success attribute.** `lib/classes/subprocess_pipe.py:17`. Callers CANNOT check correctly — the class makes it structurally impossible. (Refines A1; fix here: `self.success = self._run_process()`.)
- **[HIGH] M3 — Non-parallel worker_core returns success:True despite failed sentences.** `lib/worker_core.py:295-298`. Same disease as A5 but in the lib/ worker: 500 failed sentences report identically to a clean run.
- **[HIGH] M4 — preset_loader returns AND CACHES `{}` on any preset-module load failure.** `common/preset_loader.py:22-25`. A syntax error in an engine's presets file becomes a distant KeyError/empty voice list with no link to the real ImportError. Presets are required config; there is no valid "no presets" state.
- **[MED] M5 — worker_core `or`-chains clobber legitimate falsy TTS settings.** `lib/worker_core.py:156-163` (also 122: missing tts_engine silently becomes 'xtts'). `enable_text_splitting=False` / `temperature=0` silently flipped to engine defaults.
- **[MED] M6 — "Empty sentence — create silence" creates NOTHING.** `lib/worker_core.py:284-288`. No file written; scan_completed_sentences reports the index missing forever — a permanently un-assemblable hole the worker reported as success.
- **[MED] M7 — install_python_packages returns truthy `1` on version-parse error.** `device_installer.py:731-736` (typed ->bool; failure reads as success).
- **[MED] M8 — ArgosTranslator: NameError in the already-installed branch, masked by broad except.** `argos_translator.py:69-71` (undefined `msg`); also is_package_installed:62-64 builds an error it never surfaces → pointless re-downloads.
- **[MED] M9 — BackgroundDetector: unreadable file manufactures "background detected = True".** `background_detector.py:17-21, 60-63`. Duration-read failure → ratio 1.0 → confident wrong verdict.
- **[MED] M10 — Failed environment-marker evaluation installs the package anyway.** `device_installer.py:679-686` (platform guard silently dropped).
- **[LOW] M11 — vram_detector 4096-BYTE default (meant 4 GB?), currently dead.** `vram_detector.py:198-201`.
- **[LOW] M12 — subprocess_pipe: no timeout, no kill escalation, stderr not drained post-break, error text never captured.** `subprocess_pipe.py:78-80, 102, 115-122`.
- **[LOW] M13 — jetpack_version: unreachable dead code; future 6.x revs silently map to '61'.** `device_installer.py:198-204`.
- Clean: headers.py, coqui_patches.py (explicitly documented as NOT a fallback — correct), conf.py (designed shims; CWD-relative VERSION.txt read fails loudly = fine).

## Final tally (all three waves)

~170 findings total, ~37 HIGH, across: electron backend, e2a pipeline + auxiliaries,
both Angular apps, iOS shell, CLI, streaming scripts. Verification pass found zero
false positives among the original HIGHs.

## Final fix ordering (supersedes both earlier orderings)

1. **L1** — the queue-freezing `return` (one-line fix, unbricks the queue). Do first.
2. **E1** — bookshelf security fail-open.
3. **L2+L3** — workflow-failure cancellation for inline job types + raw-EPUB feed-through (one helper extraction).
4. **L4** — XTTS voice-load slot leak (mirror Orpheus's existing correct code).
5. **G1+G2+G4+G5** — e2a book-truncation chain (four tiny fixes).
6. **A1/M2 + A2 + A4(Voxtral) + I2** — SubprocessPipe success attr + chapter completeness + silence-for-failure family.
7. **M1** — VRAM fantasy-read (raise on cuda-probe failure).
8. **K1+K2** — phone app: res.ok check + getUrl contract (protects offline cache + offline playback).
9. **G3+G9+L7** — resume/state integrity family (corrupt state must not silently reset or be overwritten).
10. **B1-B4 + I1 + I5 + M3** — "success with empty/original content" family.
11. **J1-J3, H1-H4** — frontend surfacing batch.
12. **Corrupt-JSON family** (C5, C6, C13, E19, I9, L7 overlaps), **modifyManifest remainder** (C2, E7).
13. Everything else by area.
