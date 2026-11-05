# The reorganisation — Crucible, foundry-core, Foundry, BookForge (2026-11-04)

Lead: **bookforge pc 1** — manages, assigns and reviews; builds nothing itself. Devs: **foundry pc 1**, **crucible pc 1**, **bookforge pc 2**.
Every dev reports to bookforge pc 1. Nobody edits another dev's repo or checkout.
Owner rulings are quoted from Owen, 2026-11-04.

## The end state

1. **Crucible runs every GPU model** and hands results back, like YuE2 — Higgs included.
   *"crucible is a gpu resource distributor, like ollama."* CPU work is never Crucible's.
2. **`@owen/foundry-core`** — one headless library holding every book feature (engine,
   edit history/replay, projects, OCR, structure, export, translate, simplify, Ask,
   analysis, cleanup/triage/pronunciation readings, page capture). No UI, no Electron.
   Released as a pinned tarball. *"most features will probably go in the core library
   and then will be implemented on whichever one specifically needs the update."*
3. **Foundry** — standalone program, its own window, built modularly. Has new-book and
   page tools; does NOT have AI cleanup or the pronunciation guide. No Python.
4. **BookForge** — owns its own copy of the Foundry window, copied ONE FINAL TIME from
   the modular rebuild (*"thatll be our final revendor ... thats where they improve and
   grow separately"*). No page tools; BookForge's colour scheme; Narrate opens as a
   modal inside it. No Python: narrator's audiobook half ported to TypeScript, GPU
   scripts become Crucible calls, m4b tags native (ffmpeg from TS).
5. **Translate, simplify, Ask, analysis** stay in both apps.
6. Both apps behave as today except the ruled feature changes. **Nothing merges or
   deploys before Owen tests it.**

## Phases and order

**A — Foundry (foundry pc 1), repo `foundry`, branch `feat/foundry-core`.**
Steps 0-3 are done (33ab5e2): the package exists and Foundry's app consumes it.
A1 release tooling for the library tarball · A2 PDF Python → TypeScript on `mupdf`,
local MLX read retired · A3 Foundry window drops cleanup + pronunciation guide ·
A4 modular rebuild of oversized files (window and library) · then **Owen tests
Foundry → merge to main** (*"we can test when it's done, merge it, then do the
bookforge half"*).

**C — Crucible (crucible pc 1), repo `crucible`.** Runs in parallel with A.
C1 Higgs owned by Crucible (step a done on `feat/higgs-owned`) · C2 every GPU job
BookForge still runs locally has a Crucible service (whisper/ASR, separator, ...) ·
C3 env recipes drop narrator once BookForge no longer needs it. C4 install review: one Crucible per machine (WSL bridge = one copy managing another), one shared bootstrap installer, each app pulls only the packages it needs (BookForge: Higgs, Qwen3-ASR, …), resumable downloads, a doctor that re-downloads broken environments. Releases held for
Owen's test pass.

**B — BookForge (bookforge pc 2), repo `bookforge`, worktrees only.**
B1 (now) prep reads voice char budgets from `GET /v1/voices` instead of importing
narrator's Higgs code · B2 BookForge's GPU-script callers switch to Crucible services
(with C2; ClipForge is NOT changed — Owen: an ad hoc training tool; no dereverb in Crucible) · **after A merges:** B3 BookForge onto `@owen/foundry-core` + the final
window copy, page tools removed · B4 BookForge colour scheme · B5 Narrate modal in the
Foundry window. bookforge pc 2, while B3-B5 wait on Phase A: **B6 narrator's audiobook half → TypeScript**
(assemble, render session/retakes, VTT, text rules, compat, cli/manifest, gap
normalizing, m4b tags; Orpheus paths NOT ported; cover re-encode may differ in bytes; cli/*.py and ClipForge stay as they are; map in docs/NARRATOR-TS-PORT-MAP.md) — then python/ and electron/scripts/*.py leave BookForge.

**Final:** Owen tests BookForge + Crucible together; Crucible releases and deploys to
all four servers; BookForge merges.

## Rules for every dev

- Behaviour unchanged unless a ruling above says otherwise. Faithful ports: *"we're
  just trying to organize things better and we can work on cleaning it up later."*
- COMMIT TO MAIN AND PUSH AS YOU GO (Owen, 2026-11-04: "we can commit to main/push as we go").
  Work in a branch/worktree, and when a step passes its gates and the lead accepts it,
  rebase onto origin/main and push it to main. Never move HEAD of a checkout another
  agent uses. RELEASES, DEPLOYS and PROMOTES still wait for Owen's test pass.
- No GPU use without Owen's named go. No installer packaging.
- Baseline first, prove "unchanged" with numbers (tests, channel lists, byte diffs).
- Report to bookforge pc 1 when each step is done: commits, what changed, gate
  results, what the next dev needs.

## Owen's test list (collected as work lands)

- **Foundry from source** (`npm run electron:dev` in the foundry repo): open a book, OCR/translate, Ask, export, analysis, library list, settings, page tools on a photographed book. Clean text and the pronunciation guide are gone from Foundry (A3).
- **Packaged Foundry**: the engine loads mupdf's wasm from inside the asar; only a packaged run proves it (A2). Read a PDF's pages through Crucible end to end.
- **Leftover Python folders** Foundry no longer uses, to delete by hand: `%LOCALAPPDATA%\foundry\envs\windows-x64` and `nli-windows-x64` on the PC; `~/Library/Application Support/foundry/envs/` on the Mac.
- **BookForge**: Generate Sentences uses Qwen3-ASR, with no size picker (B2).
- **Crucible flip** (after all tests): Higgs worker (C1), built-in voices at the machine's width, install/repair (C4); the stream must sound exactly as today.

## Later, after the reorg (recorded so it isn't lost)

- Library files still over ~800 lines, left because they can be split any time without touching BookForge's window copy: node/workspace 2,370, capture 2,282, crucible-dispatch 2,062, book 1,972, ask-tools 1,622, crucible-registry 1,358, engine 1,182, app-settings 874, crucible-coordinate 816. `job-queue-carry` (1,527) is one linear function: splitting it is a rewrite, not a move.
- Members made public so the split window modules can reach them: tidy back when convenient.

(Owen's test list, B2 additions) Generate Sentences both ways in the studio; the AI setup page reads sensibly with no local-model text; ClipForge's cleanup still works. Old model folders stay on disk: whisper-models, llama-models. Packaging: build/entitlements.mac.plist still justifies DYLD for llama, review when a Mac package is next built.

(Owen's test list, C4 additions) Victoria's laptop, after the update reaches her, at her desk: `crucible doctor --verify-only --json` (read-only, 20-30 min, no GPU); read any `broken` rows before anyone runs repair there. B-Sides needs the same Repair button and detect-first install (b-side repo, no dev in this reorg).

(Later) RVC voices are `unverified` in repair: the manifest pins only the archive, so damage to unpacked files can't be detected. Closing that means re-download and compare.

(Owen's test list, A4 addition) Foundry: watch for a brief flicker when quitting. The offscreen walk's watcher flagged a window handle at exit on 3 of 4 runs of the new build and 0 of 5 of the old, with no visible window ever seen; unexplained. Not exercised offscreen: real window chrome and focus, native file dialogs, the Apply/Discard answers on the close question, anything needing a live model server or running job.

(Decided by Owen, 2026-11-05, B6 step 1 landed) m4b tag and cover writes never risk the book: "if theres a better way to do it then we should implement the safer way." Tags that fit the padding go in place through 4-byte flips; anything else is a verified new file on the same volume and one rename, at the cost of a whole-file copy on the NAS. `electron/narrator/assemble/m4b-tags.ts`, keeper `test-m4b-tags`. Still open: `encode.attach_cover` is Python until the assembly step, which must call this. The transcript embed's ffmpeg remux drops the padding (measured), so a book's first tag edit after an embed copies once and re-pads; unchanged.

(Owen to decide before B6 step 8) Orpheus reassembly is not being ported: `normalize_gaps` has no non-Orpheus caller in the app, every route being gated on `isOrpheus`. Until step 8 the library's 8 Orpheus sessions keep reassembling through today's Python, unchanged, with everything else on TypeScript. After step 8 their reassembly refuses by name and their finished m4bs are untouched; the explicit gap flags in `cli/final-denoise.js`, `cli/rvc-enhance.js` and `cli/orpheus-audiobook-render.js` must go or refuse. Default is to delete, per "orpheus is retired"; say so if those 8 must stay reassemblable, and porting comes back as work.

(Owen's test list, morning) REBOOT FIRST (about 50 GB committed with no models loaded, and 371 backgroundTaskHost processes). Then: change a book's metadata in BookForge (the first edit copies the whole book and verifies it; the next should be instant); AI setup wizard and Settings > AI on the real server ("Where each job runs" shows one row, model pickers are back); Foundry's OCR card closes when its book opens. After the reboot the lead grants the PC half of the Higgs check and BookForge's first real text job.

(Owen's test list, B6 steps 2 and 4) BookForge: resume a stopped narration and open the list of sessions; both now run in TypeScript without starting Python. One unruled change to confirm: Listen's caps fold now treats accented letters as the book path does, so an all-caps token like `ÉFBI` can read differently while streaming. Plain ASCII headings are unaffected.

(Owen to decide, not caused by the move) Short, pause-heavy lines can reach Higgs's frame cap with a `clean` verdict and no retake: "No. Not now. Not ever…" (74 chars) stopped at 396 frames, about 15 s, and "North. South. East. West…" at 433. Old and new behave the same. `capped` means the model ran out of budget before stopping itself, so the ending may be lost; nobody has listened yet. To check by ear: `bare-3-new-default.wav` and `bare-5-new-default.wav` in `mac:/Volumes/Callisto/claude-files/outbox/2026-11-05/higgs-cuts-output-mac/` (expires 11-12). Nothing changed.

(Owen's test list, B6 step 5) BookForge: assemble a Higgs book through the queue and reassemble one from the app, then cancel an assembly partway. These now run in TypeScript; only the app's screens, a real queue job and a cancel through the app are unproven. Changes to expect: cancel removes its work folder (a failure still keeps it), assembly uses more temp disk (about 172 MB per hour of book), and it took 3-22% longer in single timed runs. Known and unchanged: Southern Slavery's `sentences-rvc-rvc-voice-sigma` set refuses to reassemble on both routes, because its transcript stops 40.5 s short of the audio; it needs re-aligning, and why it is short is not known.

(Owen's test list, at the flip) Repair button, `feat/crucible-repair-button` 29578b2d: run a repair from the app against a released server and press Stop partway (it should read "The repair was stopped"). Only fakes have exercised it, and a real repair can reinstall the runtime and start the service. `package-lock.json` as well as `package.json` points at the scratch tarballs on that branch and must move to the real release.

(For Owen, B6 step 7, lead's ruling, overrule any time) Prep's HTML reading depends on libxml2's repair rules, which real books reach: measured on raw markup, 17 documents in 12 books are malformed (2 Higgs books among them) and 247 documents in 9 books get restructured. So libxml2 2.11.9 itself is being built to WebAssembly and vendored, as a binary with a rebuild script, rather than hand-copying its rules or refusing 21 books (5.3%). No Python, same engine, as Foundry did with mupdf. The cost is one vendored binary, about 1 MB by comparison with `libxml2-wasm`; its size is not yet measured. It must first prove 0 byte differences against the Python on all 13,459 documents. Also open: 11 of those 12 malformed books carry BookForge/Foundry export markers, so the exporter may be writing bad markup; foundry pc 1 is checking, read-only, and any fix waits for Owen.

(Owen to decide, after his Foundry test) Foundry's exporter still writes malformed XHTML, from table markup only: bare `<br>`, `&nbsp;` and other named entities, raw `&`, valueless or unquoted attributes, mismatched-case tags. Table text is passed through unescaped (`vlm/compile.ts:787`, `vlm/dots-book.ts:2454`, `vlm/epub-explode.ts:842`), `XHTML_HEAD` (`vlm/epub.ts:197`) writes no doctype, and the export check (`vlm/epub.ts:394`) uses an HTML-tolerant parser, so it passes all of this despite its comment. Prose is correct, and crossed `<em>`/`<strong>` was fixed in August. Lead's recommendation: normalize table markup to strict XHTML when it enters the book, and make the check strict in the same change, since a strict check alone would turn these exports into refusals. A fix does not repair existing files; those books would need re-exporting. BookForge still needs the libxml2 reader for those files and for publisher EPUBs. Open: `witches`'s export is dated after the crossed-tag fix and still has crossed tags; unexplained.

(For Owen, B6 step 7, lead accepted two small differences) Prep's cover file comes from sharp rather than Pillow: different bytes, and a CMYK cover comes out sRGB. Chinese words in the TOC titles of English-tagged books read `Bei Jing` rather than `beijing`, since porting pypinyin means carrying its dictionaries; the library run will count the books affected.

(Assignment change, 2026-11-05) foundry pc 1 takes B3-B5, starting on branch `feat/foundry-core-adopt` in a BookForge worktree while bookforge pc 2 finishes B6. Nothing from it lands on main until Owen has tested Foundry and the lead accepts it, and the window copy stays re-runnable until then.

(Owen to decide, B4) BookForge's Foundry window already uses BookForge's dark palette, and B4 makes BookForge's theme files the single source. It stays dark even when BookForge is set to light or system. Following BookForge's light/dark choice needs one new channel that also makes native menus, dialogs and scrollbars follow BookForge rather than the OS, plus a light-mode visual pass on a window designed dark-first. Not built unless Owen asks.

(Resume after Owen's reboot, 2026-11-05 evening) Branches: bookforge `feat/narrator-ts` 51869e99 (B6 step 6, unlanded), `feat/narrator-prep` 3c9be19a (step 7, unproven; libxml2 wasm never built), `feat/foundry-core-adopt` 355e839f (B3-B5 done in source, never run as an app), `feat/crucible-repair-button` 29578b2d (lands with the flip); crucible main 97798dd; foundry main d8a46a9. Then: bookforge pc 2 re-runs step 6's comparison (first ~6 sessions plus the last 15), then the prep chain, and runs gate 1 once Owen has built libxml2.wasm or allowed the build. foundry pc 1 does the fresh-clone proof, the 9f6db95c baseline, and the UI sitting with the payload capture. crucible pc 1 gets the PC arm of the Higgs same-output check, including the pause-cut and capped set. Owen tests Foundry. B4 is always dark (light/dark following is Owen's call), and after queueing from the window it stays in the window.

(Owen tested Foundry, 2026-11-05 evening) "foundry mostly looks right. though when i export an epub, it doesnt automatically fill the metadata. otherwise, looks fine". foundry pc 1 is tracing that and fixing it on Foundry main, and the fix gets re-copied into BookForge's window. Owen re-checks export after the fix.
