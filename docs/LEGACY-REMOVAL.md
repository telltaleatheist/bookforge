# Deleting the legacy local-render layer

Owen, 2026-09-15: *"Get rid of legacy logic. We've completely rebuilt the system, we don't
need legacy code hanging around."*

This is the removal order, what each deletion forces, and the refusal that replaces each
arm. It is written before the first deletion so that a half-finished tree is still
readable, and it is the record of the ONE thing that looks legacy and stays.

## What is being removed

The layer `docs/CRUCIBLE_ROLLOUT_PLAN.md` §A2 names: *"the LEGACY SPAWN LAYER (WSL
narrator, local text engines, local VLM/RVC/align spawns) behind the ONE switch
`routing.legacyLocalRender`. That layer is deleted after Owen's in-app pass."* The in-app
pass happened (§0g). This is that deletion.

After it, BookForge has **no local Python narrator and no local weight management**.
Crucible owns both (`crucible/docs/PHASE15-HOST.md`; memory `crucible-phase15-one-door`).
Every act that used to have a local arm is now **Crucible, or a named refusal**.

## The one keeper — `epub-align`

`generate-sentences` with `method: 'epub-align'`
(`electron/whisperx-align-bridge.ts` → `electron/scripts/align_audiobook.py`) is **not
legacy — it is unmigrated.** Crucible has no `align-longform` job type; the spec is §B7 of
`docs/CRUCIBLE_ROLLOUT_PLAN.md` and it is **UNRULED**. Its `align` job takes one audio
input per chunk from a caller who already knows which seconds hold which sentences, which
is precisely what this act must DISCOVER.

So it keeps its local CPU/GPU spawn and it keeps the one non-server GPU row on the bench
(`shared/queue/slot-sets.ts`, `SlotSetFacts.legacyCharged`). **The `LEGACY_LOCAL_NARRATOR`
slot-set id therefore survives this removal** — as the id of the set `epub-align` charges,
which is what §B7 and §A2's 2026-09-15 correction already say. Only its *narration*
meaning goes. Nothing in the slot-set layer is deleted here; when `align-longform` is ruled
and built, that row empties on its own and the id can go with it.

Also out of scope, and untouched: data/format migrations that merely use the word "legacy"
(`legacy-epub-layout.ts`, `legacy-variant-migration.ts`, `manifest-migration.ts`,
`bookshelf-id-migration.ts`, `archive-migration.ts`). Those are about opening old FILES.

## Removal order

Each stage is committed on its own, so the tree is never half-deleted.

### 1. This document.

### 2. The switch

`legacyLocalRender` out of the routing record, the wire, the setter, the validation, the
IPC and the Settings checkbox:

| Where | What goes |
| --- | --- |
| `electron/crucible/routing.ts` | `RoutingRecord.legacyLocalRender`, `setLegacyLocalRender`, `invalid_legacy_local_render`, the `view()` field |
| `shared/crucible/settings-wire.ts` | `RoutingView.legacyLocalRender` |
| `electron/main.ts` | `crucible:set-legacy-local-render` handler |
| `electron/preload.ts` | `setLegacyLocalRender` bridge |
| `src/app/core/services/electron.service.ts` | the same |
| `src/app/features/settings/components/crucible-servers-panel.component.ts` | the checkbox and its computed |
| `electron/queue-engine.ts`, `electron/queue-ipc.ts` | the `legacyLocalRender` field on the routing host and the IPC view |
| `shared/queue/wait-for.ts` | `WaitForFacts.legacyLocalRender` |

**An old record carrying `legacyLocalRender: true` must never be silently honoured and
must never brick startup.** `Routing.read()` therefore **strips the key on read and says
so ONCE on the log, by name**, whatever its value. It is not a corrupt record (it was
valid when it was written), there is no migration prompt, and nothing rewrites the file
behind the operator's back. The next render then fails honestly with `no_enabled_server`
— which is the answer an operator can act on — instead of quietly taking a card.

### 3. The venue arms

Narrow the union type FIRST, then let `npx tsc --noEmit` enumerate the call sites. That is
the complete work list and it cannot miss one.

| Union | Arm removed | What replaces it |
| --- | --- | --- |
| `GenerationVenue` (`electron/crucible/generation-venue.ts`) | `{where:'legacy-local-narrator'}` | Answer 2 is gone; the record's answers 3 and 4 stand, and `no_enabled_server` / `no_reachable_server` are the refusals |
| `RunVenue`, `StepVenue` (`electron/crucible/step-venue.ts`) | the same | a row whose `waitForResolved` is `legacy-local-narrator` is refused `legacy_venue_retired` by name, never re-decided — re-deciding would send a half-rendered book to a different machine |
| `TextActVenue` (`electron/crucible/text-venue.ts`) | `{where:'legacy-local-engines'}` | forced by the switch's removal; §A2 names the local text engines as part of this layer. Refusal is `no_enabled_server` from the record |
| `VlmVenue` (`shared/vlm/conversion.ts`) | `{where:'legacy-local-narrator'}` | a typed endpoint in Settings → AI → Reading pages still wins and is untouched; with none, it is Crucible or the record's refusal |
| `WaitForVerdict` (`shared/queue/wait-for.ts`) | `{kind:'legacy-local'}` | a resolved `legacy-local-narrator` row HOLDS with a sentence naming the retirement |

`LEGACY_LOCAL_NARRATOR` the CONSTANT stays — see the keeper above. `waitForLabel` keeps a
line for it so an old row still reads as something.

### 4. The `legacyLocal:` dependency arms

Nine modules take a `legacyLocal` callback as the local half of a Crucible door. Each is a
literal fallback and each goes; the door then has one arm.

`electron/crucible/{asr,denoise,rvc,reroll}.ts`,
`electron/{denoise-job,rvc-job,correct-sentences-bridge,generate-sentences-bridge,coverage-align-job}.ts`,
plus `electron/vlm-convert.ts`.

Where the local callback was the whole implementation of an act (`deriveDenoisedSentences`,
`transcribeLocally`, `runCoverageAlignLocally`), the implementation goes with the arm
unless something else calls it.

### 5. The spawn layer

The dead halves behind `venue.where === 'crucible'` in `electron/parallel-tts-bridge.ts`,
`electron/reassembly-bridge.ts` and `electron/streaming-engine.ts`
(`legacySwitchIsOn`, `electron/crucible/stream.ts`'s `local()`), then every module that
becomes unreachable: the Orpheus engine (`orpheus-worker-pool.ts`, `orpheus-models.ts`,
`orpheus-hf-catalog.ts`) and whatever in `narrator-spawn.ts`, `higgs-spawn.ts`,
`higgs-doctor.ts`, `higgs-hf-install.ts`, `higgs-models.ts`, `tool-paths.ts` and
`components/component-manager.ts` nothing imports any more. Files are deleted outright; no
stubs.

**Orpheus is RETIRED, not silently dropped.** `shared/tts/engine-caps.ts` already keeps
`orpheus` as a `RetiredTtsEngine` so an old record parses and displays as "Orpheus
(retired)" (commits `c167d5ea`, `b593e56f`). That property is not part of the spawn layer
and must survive. The Listen/streaming picker is a SEPARATE union (`StreamEngineName` in
`electron/streaming-engine.ts`, `worker-config.service.ts`) and still names Orpheus; it is
retired the same way — kept parseable, not selectable.

### 6. Keepers

Tests that assert the legacy path EXISTS are fixed or deleted; one is added that pins its
ABSENCE — a routing record carrying `legacyLocalRender: true` produces no local render.

Gate: `npx tsc --noEmit` clean, the keeper suite's EXIT CODE, and `ng build` for anything
under `src/`.

## If a deletion would strand a feature

`epub-align` is the one that was found before starting. Anything else that turns out to
have no Crucible equivalent is REPORTED and left standing, with the reason — not deleted,
and not given a stopgap.
