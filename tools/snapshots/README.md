# tools/snapshots

Committed captures that a keeper diffs against. Each is regenerated
**deliberately**, never to make a failing test pass — the point of a snapshot is
that a change to it is a decision somebody made on purpose.

| file | keeper | what it pins |
|---|---|---|
| `narrator-argv-base.json` | `tools/test-narrator-argv-snapshot.js` | the seven narrator doors: their argv literals, and the plan (interpreter, env, cwd) each produces on wsl / native-win / native-mac |
| `serve-spawn-base.json` | `tools/test-serve-spawn-env.js` | the Listen server's spawn as it stood BEFORE the narrator cut-over, so the 33 preserved environment variables can be diffed against it |
| `orpheus-argv-base.json` | *(none — historical)* | see below |

## `orpheus-argv-base.json` is history, not a baseline

It records the five ebook2audiobook command lines BookForge sent — prep, retake,
the lightweight worker, the `app.py --worker_mode` worker, and assembly —
generated from `01a3799b`, the commit the Higgs work was cut from.

**Nothing tests against it.** Phase 3 of the e2a removal replaced all five doors,
so its extractor's anchors name code that no longer exists; the keeper that read
it (`tools/test-orpheus-argv-snapshot.js`) was retired at the same time and
deleted once it could no longer run at all. The file is kept because it is the
last written record of exactly what this app asked ebook2audiobook to do, and
`docs/NARRATOR_CUTOVER.md` quotes it door by door in the Phase 3 before/after
table.

One caveat on reading it: it is **no longer `01a3799b` byte for byte**. The
`feat/xtts-removal` branch regenerated its assembly row on 2026-09-05 when it
deleted the bilingual arm (`--bilingual`, `--bilingual_pause`, `--bilingual_gap`).
Every other row is the pre-Higgs original.
