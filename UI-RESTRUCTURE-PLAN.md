# UI Restructure Plan

Written 2026-06-10. Authored after a full UI survey (routes, nav, Studio, pdf-picker, both wizards, queue, settings). Execute phases in order; each phase is independently shippable. **Do one phase at a time and verify the app builds and runs before moving on.**

## Why (user's framing)

- **Library exists for archival work**: original, unchanged copies of books (e.g., Dannenmann's 1933 *Deutsche Christen* church history) must be retained byte-for-byte, alongside derived versions (OCR'd PDF, cleaned EPUB, translated EPUB, simplified EPUB, M4B).
- **Studio exists solely for the TTS pipeline.** Library doesn't use TTS at all — but the two duplicate functions like metadata management.
- **Past Sessions (reassembly) is rarely used** — its function already exists in Studio as an automatic feature. Remove the page.
- **Post-Processing doesn't belong in this app** — could live in a separate app. Remove the page.
- **"Buttons everywhere that go to the same place"** — multiple entry points for opening the editor, multiple ways to review changes. The raw file structure shouldn't be exposed to the user, but the user MUST keep the ability to compare any two processing outputs (original vs translated, translated vs cleaned, cleaned vs simplified, etc.).
- End state for Library + Studio: **one merged feature with two views** (library/archival view and studio/production view) over one collection where each book holds all its versions.
- **Analysis is fundamentally a different function than AI cleanup and TTS** and does not belong in the processing pipeline. It becomes its own surface.
- **Edit must be available everywhere**, and saving in the editor always creates a NEW copy (a version) — never overwrites — which the user can export as PDF, EPUB, etc.
- **Language learning is the same pipeline as standard processing**, differing only in translation mode, TTS row count, and assembly. One wizard, not two.

## Target interaction model (governs all UI decisions below)

A **book** has three kinds of things:
1. **Versions** (documents): Original (immutable, archival), Edited copies, Cleaned, Simplified, Translated-{lang}, bilingual per-language EPUBs.
2. **Audio** (outputs): M4B files (mono or bilingual), each linked to the version it was generated from.
3. **Reports**: analysis results (propaganda/rhetoric), skipped-sentence logs.

Five **verbs**, each implemented exactly once with one handler:
- **Edit** — open any version in the editor. Save = create a new version on the book. Available on every version row in every context (same handler). Export any version as EPUB/PDF/TXT.
- **Process** — the single pipeline: Clean → Translate → TTS → Assemble. One wizard.
- **Compare** — diff any version against any other (generalized diff-view). "Review Changes" is Compare(cleaned, its input) and stops being a tab.
- **Analyze** — run analysis on any version; produces a report. Lives in its own "Insights" tab, NOT in the pipeline.
- **Listen** — player for audio outputs. "Stream" (live TTS preview of an EPUB) folds in here as a preview mode.

A selected book shows **four tabs: Versions · Process · Listen · Insights**. The current 7 audiobook sub-tabs + 3 LL sub-tabs are eliminated by mapping:
- `process` (both pipelines) → Process tab (unified wizard)
- `stream`, `play` (both) → Listen tab
- `review` (both) → Compare action on version rows
- `skipped` → report link on the audio output row (Versions tab)
- `enhance` → action on the audio output row
- `chapters` (recovery) → action on the audio output row
- Articles' `Content` tab → Edit verb for articles (the article element editor IS the editor for that item type)

Button consolidation rule: a verb appears on the row of the thing it acts on, and nowhere else. Context menus may shortcut to the same handlers but never to separate implementations. No global quick-action bar duplicating row actions.

## Constraints (do not violate)

- **Originals are sacred.** Nothing may modify or move `source/original.*` content destructively. Any migration must verify originals byte-identical afterward (checksums).
- A TTS job may be running (queue persists in `~/Library/Application Support/bookforge-app/queue.json`). Don't break queue job-type handling — removing a UI page must not remove electron-side job logic that the queue or Studio still uses.
- Cross-platform (Mac + Windows): path separators, `metaKey||ctrlKey`.
- Library folder is Syncthing-synced: all writes atomic (staging + rename), relative paths in manifests.
- CLAUDE.md "Code Principles": fix root causes, no silent fallbacks, no legacy compat shims.
- A full backup zip exists at `/Volumes/Callisto/Shared/BookForge-backup-2026-06-10.zip` (everything except `*.flac`, `*.wav`, `cache/`). Verify it exists and is >50 GB before any phase that touches the library folder (Phase 2 migration). Phases 1 and 3 only touch app code, not the library.

## Current state (survey findings)

- **Nav rail** (items defined in `src/app/app.ts` ~lines 120–158; a *second, divergent* hardcoded list lives in `src/app/components/nav-rail/nav-rail.component.ts` — app.ts is the authoritative one): Library, Studio, Queue, Past Sessions (`/reassembly`), Post-Processing, Settings.
- **Routes** (`src/app/app.routes.ts`): live → `/library`, `/studio`, `/queue`, `/settings`, `/reassembly`, `/post-processing`, `/editor` (standalone window), `/alignment` (standalone window). Legacy redirects → `/audiobook`, `/epub-editor`, `/language-learning`, `/pdf-picker`. Unused → `/home`, `/components`.
- **Dead/vestigial code**: `features/epub-editor/` (unrouted, ~46 KB), `features/language-learning/language-learning.component.ts` (unrouted, ~94 KB — but `components/ll-wizard/` and others in that dir ARE used by Studio), `features/audiobook/audiobook.component.ts` (unrouted, ~62 KB — but `components/` under it ARE used: diff-view, play-view, post-processing-panel, etc.). Dead navigations: `pdf-picker.component.ts` ~line 4528 → `/audiobook`; `reassembly.component.ts` ~line 1315 → `/audiobook`.
- **Studio** (`features/studio/studio.component.ts`, 2,254 lines): left list + right tabs (Files / Content / Audiobook / Language Learning), 7 audiobook sub-tabs, 3 LL sub-tabs. All tab state is signals, no URL state; selecting an item force-resets tabs. `project-files.component.ts` (936 lines) exposes the raw file tree — this is the "review changes between jobs" workaround.
- **Wizard duplication**: `process-wizard.component.ts` (3,851 lines) and `ll-wizard.component.ts` (3,749 lines) share ~1,200–1,400 near-identical lines (provider picker, model dropdown, test-mode buttons, workers, custom instructions, step indicator, review cards). NOT in scope for Phases 1–3; future phase.
- **Library feature** (`features/library/`): `EbookLibraryService`, category folders under `{libraryRoot}/ebooks/`, tags in `{ebooks}/.cache/metadata.json` — a separate tag system from Studio's.
- **Library disk layout** (`/Volumes/Callisto/Shared/BookForge`): `projects/` 284 GB (source 3 GB, stages 170 GB mostly FLAC TTS sessions, output 108 GB = 66 GB M4B + 42 GB FLAC intermediates), `ebooks/` 6.2 GB, `cache/` 7.2 GB, plus `audiobooks/`, `files/`, `media/`, `language-learning/`, `logs/`.

---

## Phase 1 — Nav rail cleanup + dead code purge (app code only, low risk) ✅ DONE 2026-06-10 (commit 3cf4936)

Goal: nav rail becomes **Library, Studio, Queue, Settings**. No behavior change beyond removed pages.

1. **Remove Past Sessions page**: delete `src/app/features/reassembly/`, its route in `app.routes.ts`, its nav item in `app.ts`. KEEP electron-side reassembly handlers and the `ReassemblyJobConfig` queue job type — Studio's automatic reassembly uses them.
2. **Remove Post-Processing page**: delete `src/app/features/post-processing/`, its route, its nav item. KEEP the electron Resemble Enhance bridge and the Enhance sub-tab inside Studio's Audiobook tab for now (it's the same backend; removing the standalone page is what was asked). If grep shows the post-processing page dispatched a custom `navigate-to-queue` event, remove the listener too.
3. **Dead route purge**: remove `/home`, `/components` routes and their page components if nothing else imports them; remove legacy redirect routes (`/audiobook`, `/epub-editor`, `/language-learning`, `/pdf-picker`) AFTER fixing every `router.navigate` that still targets them (grep for `'/audiobook'`, `'/epub-editor'`, `'/language-learning'`, `'/pdf-picker'` across src/). The pdf-picker dead link (~line 4528) should navigate to `/studio` or be removed.
4. **Dead component purge**: delete `features/epub-editor/` entirely; delete `features/language-learning/language-learning.component.ts` (and its template/styles) but NOT the rest of that feature dir; delete `features/audiobook/audiobook.component.ts` (and template/styles) but NOT `features/audiobook/components/`. Before each deletion, grep for imports of the symbol to confirm nothing references it.
5. **Single source of truth for nav items**: nav-rail.component.ts has its own hardcoded item list that diverges from app.ts. Make it purely input-driven (`[items]`), delete the hardcoded list.
6. Verify: `npm run electron:dev`, click through all four remaining nav items, open the editor window from Studio, confirm queue still lists/runs jobs.

## Phase 2 — Merge Library + Studio into one feature with two views ✅ DONE 2026-06-10 (commits 38c27a0, a526efd, a28614e)

Done differently/better than originally drafted below: instead of a separate "Books" feature, the unified view lives in StudioComponent with a **Browse (cover grid) / Workspace (list+workflow)** toggle. Data migration (191 new projects + 5 attaches, all SHA-256 verified, ebooks/ intact) reconciled every archival ebook into a manifest project. Old ebooks-based Library feature deleted; nav collapsed to Library · Queue · Settings (Library → /studio). `ebooks/` still on disk (redundant) — delete manually only after in-app verification. Known follow-ups: ~17 imperfect-metadata books (mostly Children category) to fix in-app; tag editing on projects; the 10 junk-titled ebooks left in ebooks/.

### Original draft (superseded, kept for reference)

Goal: one collection, one metadata/tag system, two views. This is the largest phase; sub-plan before executing.

**Concept**: every book is one manifest project. A book the user has only archived simply has no `stages/` yet. The UI offers a view toggle:
- **Library view** (archival): cover grid, categories/tags, read-only originals, import, metadata editing. No pipeline UI.
- **Studio view** (production): the existing list + workflow tabs (process wizard, play, review).

Both views read the same `manifestList()` data. `StudioItem` and `LibraryBook` converge on the manifest model.

**Data migration** (the risky part — requires the backup verified):
1. Write a migration (electron-side, runs once, with a dry-run mode that only reports) that walks `{libraryRoot}/ebooks/` category folders + `.cache/metadata.json` and for each ebook creates a manifest project: copy (not move) the file to `projects/{slug}/source/original.{ext}`, carry title/author/year/tags/category into `manifest.json` (category becomes a tag or a `collection` field), copy cover into `media/`.
2. Checksum every original before and after (SHA-256 manifest written to a report file). Abort on any mismatch.
3. Leave `ebooks/` untouched until the user has confirmed the merged view works; deletion of `ebooks/` is a separate, manual, later step. (Disk cost of duplication: ~6 GB — acceptable.)
4. Books that exist in BOTH ebooks and projects (same title/author): don't duplicate — attach the ebook file as an additional version/source in the existing project, or skip with a report line for manual resolution. Prefer skip-and-report for v1.
5. Unify tags: Library tags from `.cache/metadata.json` merge into manifest tags.

**UI work**:
- New route structure: `/books` (with `/library` and `/studio` redirecting to it, preserving muscle memory). View toggle (grid ⇄ workflow) persisted in localStorage.
- Library view reuses the existing library grid component bound to manifest data; Studio view is the existing studio split-pane.
- One import flow (the existing add-modal) used by both views.

## Phase 3 — The four-tab book view: Versions · Process · Listen · Insights ✅ MOSTLY DONE 2026-06-10/11

Done: Versions tab (studio-versions; Compare any two EPUBs via generalized diff-view, Edit/Export/Delete per row; Enhance/Fix Chapters on audio rows; Skipped report on the cleanup row — commits d17fc32, f2d2bbb, 32d4c84). Listen tab (play + stream). Insights tab (commit 20b51f4). Remaining from 3c: editor save still has its legacy exit paths (save-as-new-version unification not done); articles still use the Content tab rather than the Edit verb.

### Original spec (kept for reference)

Goal: implement the target interaction model. The user never sees raw paths, can compare any two pipeline outputs, can edit from anywhere, and there is exactly ONE way to do each action. This replaces the Files/Content/Audiobook/Language-Learning tab maze and its 10 sub-tabs.

### 3a. Versions tab (replaces the Files tab / `project-files.component.ts`)

1. Derive a version list from canonical locations (CLAUDE.md "Canonical File Locations"):
   - Original (`source/original.*`) — badge: archival, immutable
   - Edited (`source/exported.epub`, plus new editor-saved copies — see 3d)
   - Cleaned (`stages/01-cleanup/cleaned.epub`) / Simplified (`stages/01-cleanup/simplified.epub`)
   - Translated {lang} (`stages/02-translate/translated.epub` or `{lang}.epub`)
   Each document row: name, date, size, provenance (which version it was derived from), actions: **Edit**, **Compare…**, **Export…**, **Delete** (Delete disabled on Original).
2. **Audio section** below documents: each M4B output row with actions: **Listen**, **Export…**, **Enhance** (Resemble job → queue), **Fix Chapters** (VTT chapter recovery), **Skipped Sentences** (report view), **Delete**. This absorbs the `enhance`, `chapters`, and `skipped` sub-tabs — delete those sub-tabs and route their existing components/handlers through the row actions.
3. **Compare any two versions**: Compare… on a row opens a picker for the other side, feeding the existing `diff-view` component generalized to accept two arbitrary EPUB paths. Subsumes "Review Changes" (the `review` sub-tab in both Audiobook and LL) — delete those sub-tabs. The queue's diff modal keeps using the same generalized component.
4. The raw file browser (`project-files.component.ts`) is removed from the main UI (may survive behind a developer toggle).

### 3b. Listen tab (replaces `play` + `stream` sub-tabs in both pipelines)

One player surface: select an audio output (or arrive via a row's Listen action). Includes the live-TTS "Stream" preview as a mode for books with no audio yet. Bilingual outputs use the same tab (the existing bilingual player component slots in based on output type).

### 3c. Edit everywhere, save-as-new-version (the universal Edit verb)

1. **One entry point**: every version row's Edit action opens the `/editor` window with that version. Remove ALL other edit buttons — grep `openEditor` call sites (quick-actions bar, context menu, files tab, library view) and consolidate to one handler. Same audit for Play and Review buttons.
2. **One exit behavior**: the editor currently has three save paths (embedded "Complete" → emit finalized; library "Export" → export modal; source "Save" → replace-vs-save-as modal). Unify: **Save always writes a new version into the book's project** (never overwrites; Original untouched), named/numbered (e.g., `source/edited-2.epub` or dated) and registered so it appears as a Versions row. Export (PDF/EPUB/TXT via the existing `export.service.ts`) is a separate explicit action available on any version row, not a side effect of saving.
3. Articles: the Content tab's element editor is the Edit verb for articles — launched the same way, same save-as-new-version semantics (finalize → new EPUB version). The Content tab itself goes away.

### 3d. Verification

With a real project (e.g., the Dannenmann book): original→translated, translated→cleaned, cleaned→simplified comparisons all open; editing the original produces a new version and leaves `source/original.*` byte-identical; Enhance/Fix Chapters/Skipped reachable from the audio row; nothing reachable two ways.

## Phase 4 — One pipeline wizard + Analysis becomes Insights ✅ DONE 2026-06-11 (commits a6bd507, 20b51f4)

Done differently than drafted: instead of extracting shared sub-components first, the ll-wizard was extended into the unified wizard (its Translate step gained the "Translation Type" switch: Whole Book vs Sentence-Aligned) and process-wizard was deleted. Mono mode submits exactly the old process-wizard job set (master `audiobook`, `ocr-cleanup`/`bilingual-cleanup`, `bilingual-translation` with `monoTranslation:true`, single `tts-conversion`, `reassembly` chained or from cached session, `video-assembly` monolingual); sentence mode is unchanged LL behavior. Analysis moved to the Insights tab (`studio-insights.component.ts`). Note: the unified wizard still lives at `features/language-learning/components/ll-wizard/` under the `LLWizardComponent` name — a rename/move to `features/studio/components/pipeline-wizard/` is cosmetic follow-up.

### Original spec (kept for reference)

Goal: merge `process-wizard.component.ts` (3,851 lines) and `ll-wizard.component.ts` (3,749 lines, ~40% duplicated) into ONE wizard, and remove Analysis from the pipeline.

1. **Extract shared sub-components** first (used by both today, then by the merged wizard): AI provider picker, model dropdown w/ auto-detect, parallel-workers buttons, test-mode buttons (Full/3/5/10/20), custom-instructions textarea, processing-options toggles, step indicator, review cards.
2. **Unified wizard steps**: Clean → Translate → TTS → Assemble → Review. The **Translate step has a mode switch**:
   - *Whole book*: single target language → `stages/02-translate/translated.epub` → one TTS row → mono assembly → `output/audiobook.m4b`
   - *Sentence-aligned (language learning)*: N target languages → `stages/02-translate/{lang}.epub` + sentence pairs → one TTS row per language → interleave assembly (pause/gap controls, video option) → `output/bilingual-{src}-{tgt}.m4b`
   TTS and Assembly steps render based on the chosen mode. Job types submitted to the queue are unchanged (`bilingual-*`, `tts-conversion`, etc.) — this is a UI merge, not a backend change.
3. **Remove the Analysis step from the wizard.** Create an **Insights tab**: pick a version + provider/model → submits the existing `BookAnalysisConfig` job → completed reports listed in the tab (and the existing analytics history can live here). No pipeline coupling.
4. Delete whichever wizard component remains unused after the merge; both Audiobook-Process and LL-Process sub-tabs collapse into the single Process tab.

## Future phases (not now — listed so they aren't re-litigated)

- **Phase 5**: URL-based tab state (`/books/:id/...`), stop resetting tabs on item selection, remove the `?home=timestamp` hack.
- **Phase 6**: decompose `pdf-picker.component.ts` (11,207 lines) / `pdf-viewer.component.ts` (5,419 lines) into a formal mode system.

## Housekeeping during execution

- Update CLAUDE.md where it's stale (it claims Library was merged into Studio and `/library` redirects — false today; make it true as phases land).
- `queue.json` (app support dir AND a copy at the library root, which is Syncthing-synced) embeds Claude/OpenAI **API keys in plaintext** in job configs. Flag for a later fix: strip keys from persisted job configs and read them from settings at run time.
- Commit after each numbered step, descriptive messages, on a feature branch (e.g., `ui-restructure-phase-1`).
