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
(with C2) · **after A merges:** B3 BookForge onto `@owen/foundry-core` + the final
window copy, page tools removed · B4 BookForge colour scheme · B5 Narrate modal in the
Foundry window. bookforge pc 2, while B3-B5 wait on Phase A: **B6 narrator's audiobook half → TypeScript**
(assemble, render session/retakes, VTT, text rules, compat, cli/manifest, gap
normalizing, m4b tags; Orpheus paths NOT ported; cover re-encode may differ in bytes; cli/*.py and ClipForge stay as they are; map in docs/NARRATOR-TS-PORT-MAP.md) — then python/ and electron/scripts/*.py leave BookForge.

**Final:** Owen tests BookForge + Crucible together; Crucible releases and deploys to
all four servers; BookForge merges.

## Rules for every dev

- Behaviour unchanged unless a ruling above says otherwise. Faithful ports: *"we're
  just trying to organize things better and we can work on cleaning it up later."*
- Branches/worktrees only. No merge to main, no release, no deploy without the lead
  saying Owen has tested. Never move HEAD of a checkout another agent uses.
- No GPU use without Owen's named go. No installer packaging.
- Baseline first, prove "unchanged" with numbers (tests, channel lists, byte diffs).
- Report to bookforge pc 1 when each step is done: commits, what changed, gate
  results, what the next dev needs.
