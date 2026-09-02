# HANDOFF — list items must be their own TTS chunks (never packed with neighbours)

**Filed:** 2026-09-01 23:15 (orpheus-finetune loop investigation, Owen's call)
**Owner:** BookForge / ebook2audiobook prep. **Size:** small, two edits in one file + a test.

## Why

The Orpheus stop prior fails most on **enumerated list text**. Across 25 runs of the
272-draw loop battery (thirdreich models, quicktrains, and the stock base), the caps
come from a handful of texts and the worst is a numbered propaganda list
(`run893`: "…date a Jew. thirteen. A printer is represented by… fourteen. …").
Stock `orpheus-3b-0.1-ft` caps on that battery at 16–24/272 (leo/tara); every
fine-tune improves it but none removes it. The failure is the model re-speaking the
final list phrase instead of emitting EOS. A list packed into one ~500-char chunk is
the worst possible input; one item per chunk removes the repetition primer entirely.
This is an inference-side fix that helps every voice, independent of training.

## Where the type is lost (verified 2026-09-01, file:line)

Foundry emits lists as typed blocks and stamps them into the EPUB:
- `foundry/src/vlm/dialect.ts:43` — `{ kind: 'list'; ordered; items }`
- `foundry/src/vlm/epub.ts:458-462` — writes `<ul>/<ol>` + `<li>`
- `foundry/src/translate/blocks.ts:14,35` — `data-bf-cat="list-item"` on `<ul>` and `<li>`

BookForge carries the category but the narration path only branches on caption/footnote:
- `bookforge/electron/parallel-tts-bridge.ts:6709-6723` — `narrationInputFor()`; no `'list'` branch.
The EPUB reaches e2a prep with `<li>` intact.

**e2a drops it.** The packing for the app-faithful path is ebook2audiobook prep
(`renderRangeHeadless` → `prepareSession` → `lib/core.py get_sentences`), not BookForge:
- `ebook2audiobook/lib/core.py:1246-1249` — `heading_tags=h1..h6`, `break_tags=[br,p,span]`,
  `pause_tags=[div]`. **`ul/ol/li` are in none of them.**
- `ebook2audiobook/lib/core.py:1184-1192` — the transparent-inline `else:` branch: an `<li>`
  emits no break token, so consecutive items are welded into one prose row at
  `core.py:1487` (`' '.join(clean_list)`) before PASS 5 ever sees them.
- PASS 5 Orpheus packer: `core.py:2597` → `_balanced_groups` `:2694` → `_group_run` `:2672`
  → `_emit` `:2736`; input is `final_list` (`:2504`), **plain strings, no type field**.

## The fix (mirror the heading mechanism)

Headings already do exactly what lists need. `sml_heading(title)` (`core.py:3308`) prefixes
an SML marker to the row; `_heading_row_test` (`core.py:1975`) builds `is_heading(row)`;
and at the packer's insertion point every heading row becomes an un-packable item:

```python
# core.py:2730
items.append((s, None if (not core or _has_escaped_sml(core) or is_heading(s))
              else (lead, core, trail, s)))
```
An `edges is None` item breaks the run and is emitted alone (`core.py:2760-2764`).

1. **Mark `<li>` in `_tuple_row`** (`core.py:1131-1192`, next to the `name in heading_tags`
   branch at `:1135`): each `<li>` starts a new row carrying a list-item marker, the way
   `sml_heading` marks headings. Also treat `<li>` as a break so items never weld
   (`:1487`). Whatever marker is chosen must be stripped before synthesis exactly as
   `[heading]` is (orpheus.py:1194 strips SML; an unstripped marker gets SPOKEN — the
   "break" incident in TESTING_BIBLE 08-27).
2. **Add `or is_list_item(s)` at `core.py:2730`** (and mirror in the Voxtral packer `:2589`,
   `_merge_short_headings_forward` `:1877`, `_apply_min_chars_floor` `:2006`, which take
   `is_heading`), so a list item is always its own chunk. Do NOT let
   `_apply_min_chars_floor` merge short items back together.
3. Ordinal-only items ("13.", "fourteen.") should stay attached to their own item text,
   not become a chunk of one word — the split is per `<li>`, not per sentence.

## Test

- Unit: an EPUB fragment with `<ol>` of 8 short `<li>` → prep emits 8 chunks, each
  item text intact, no marker text in the emitted string.
- Regression: `pipeline/ladder.py` (orpheus-finetune) on a thirdreich model with the
  list texts rendered per-item vs packed — expected: run893-class caps → ~0 per item.
- Ear: pauses between items should come from the assembly gap, not from packed prosody;
  scan for exact-zero runs per TESTING_BIBLE 08-31 rules.

## Not in scope
Any change to BookForge's `splitForTts` (`bilingual-processor.ts:738`) — that packer is
only on the live reader / API streaming paths.

## Landed — e2a `e3349425` (2026-09-01/02), BookForge `e2238ca7`

Shipped as specified, with two deviations forced by the code and one addition from review:

- **Single non-paired leading `[item]` marker** (`TTS_SML['item']`, in `SML_UNSPOKEN_PATTERN`),
  no closing half: `normalize_sml_tags` rejects `[/tag]` on a non-paired tag and requires a
  value on a paired one, the same wall `[heading]` hit on 08-27.
- **An item row is a RUN BOUNDARY in the packers, not an `edges is None` row.** Emitting the
  marked row alone would strand the item's own later sentences ("13." as one generation,
  "A printer is represented by…" as the next). Instead `is_item(s)` flushes the run and opens
  the item's own, and while a run belongs to an item any row carrying an escaped token
  flushes it too — PASS 1 ends a row immediately before a token and lets a row start on
  tokens, so the item's remaining sentences are exactly the token-free rows that follow, and
  the next item / trailing paragraph always opens on `[break]`. Voxtral packer mirrors it.
- **Min-chars floor:** items exempt in both directions regardless of length (step 2 as
  written); `_merge_short_headings_forward` NOT extended. Addition from review: on the
  engines with **no packer** (XTTS-class, F5) a short item row may gather the token-free row
  immediately after it — only ever its own next sentence — so "13." stays attached to its
  text on every engine, not just Orpheus/Voxtral.
- `_convert_sml` accepts `[item]` as silent markup; `_heading_row_test` generalized to
  `_marker_row_test(sml_blocks, tag)`; BookForge's `correct-sentences-bridge.ts` SML strip
  regex includes `item` (QA list display only).

Test: `tools/test_list_item_chunks.py` (real `filter_chapter` → `get_sentences`, three
engines, one chunk per item, no marker in spoken text) + the existing heading / twin-anchor /
VTT tests, all exit 0. Owed: the run893 ladder regression (orpheus-training), and an ear
check that one-word `<li>` chunks (~9 chars, a new population in the short-chunk overrun
report) are voiced.
