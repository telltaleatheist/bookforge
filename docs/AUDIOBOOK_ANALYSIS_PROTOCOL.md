# Audiobook Analysis Binding Protocol

Version: `bookforge-audiobook-analysis-v1`

## Purpose

An audiobook analysis report is valid for exactly one project audiobook variant
and exactly one set of M4B bytes. A document analysis is never eligible for the
bookshelf player.

## Identity

Every binding contains:

- `projectId`: the manifest project that owns the audiobook.
- `variantId`: the stable audiobook variant selected through `manifest.json`.
- `m4bPath`: the project-relative path recorded for audit purposes.
- `m4bSha256`: SHA-256 of every byte in the resolved M4B.
- `transcriptSha256`: SHA-256 of the canonical cue stream described below.
- `transcriptDigestAlgorithm`: `bookforge-vtt-cues-v1`.
- `cueCount`: the number of canonical cues.
- `analysisId`: a UUID naming one immutable report directory.

Neither a renderer-supplied filesystem path nor a filename is an identity.
The Electron main process resolves `projectId + variantId` through the manifest.

## Canonical transcript digest

The transcript is resolved using the same authoritative rule as playback:

- Monolingual M4B: the embedded transcript track.
- A format whose manifest explicitly owns a sidecar: that variant's sidecar.

After strict WebVTT parsing, each cue is represented as:

```json
{"index":0,"startMs":1250,"endMs":4810,"text":"The spoken text."}
```

The digest input is the UTF-8 JSON serialization of the complete ordered array.
Times are integer milliseconds. Cue text has CRLF converted to LF, surrounding
whitespace removed, and internal whitespace collapsed to one ASCII space. No
locale-sensitive transformation is allowed.

## Canonical storage

Document analysis remains at:

```text
stages/04-analysis/analysis.json
```

Audiobook reports are immutable envelopes at:

```text
stages/04-analysis/audiobooks/{analysisId}/analysis.json
```

`manifest.audiobookAnalyses[variantId]` is the only authoritative pointer to an
audiobook report. The pointer also stores SHA-256 of the complete report JSON,
so structurally valid edits to a committed payload are rejected. Code must never
scan the report directories to select one.

## Write transaction

1. Resolve `projectId + variantId` through the current manifest.
2. Hash the exact M4B and canonical authoritative transcript.
3. Analyze cue-numbered chunks. Model output may identify only cue indices that
   were present in the submitted chunk; timestamps are derived locally.
4. Resolve and hash the variant again immediately before committing.
5. Abort if the path, M4B hash, transcript hash, algorithm, or cue count changed.
6. Atomically write the immutable report envelope to its UUID directory.
7. Atomically update the manifest pointer last.

An interrupted write can leave an orphan report, but it cannot make that report
active because readers never scan for reports.

## Chunk recovery and checkpoints

Analysis chunks are made only from complete canonical VTT cues. A failed chunk
is handled in this order:

1. Retry transient request failures up to three total attempts with backoff.
2. For invalid structured output, refusals, output-limit failures, or empty
   responses, immediately split the chunk near its text midpoint but only
   between cues. Never pay for a same-size correction request.
3. Repeat recursively. If a single-cue leaf still fails, record that exact cue
   range as skipped. Never invent a finding or move it to another cue.

Model quotes are first checked verbatim against their claimed cue range. A fuzzy
match may establish that the model lightly normalized the same words, but the
persisted quote is then replaced with the exact authoritative VTT text from that
range. A quote with no defensible match is invalid output and enters recovery.

After each completed top-level chunk, BookForge atomically checkpoints the exact
M4B/transcript binding, provider, model, category digest, completed chunk indexes,
findings, skipped ranges, and request-attempt count under:

```text
stages/04-analysis/audiobooks/progress/{variant-key}.json
```

A checkpoint resumes only when every source and configuration identity matches.
A source/configuration mismatch deletes that checkpoint and starts a new bound
run. A malformed checkpoint is an error, not a silent restart.

Skipped ranges are part of the signed report payload and, when non-empty, are
also written to the report directory as `skipped-chunks.json`. The player must
show that the analysis is incomplete and identify playback inside a skipped
range. Ten skipped leaf ranges abort the run instead of publishing a severely
incomplete report.

## Read transaction

Before serving a report, BookForge must require all of the following:

1. The project and audiobook variant resolve through the current manifest.
2. The complete report bytes match the SHA-256 stored in the manifest pointer,
   and the manifest pointer and report binding agree field-for-field.
3. The report schema and every cue range are valid.
4. The current exact M4B SHA-256 equals `m4bSha256`.
5. The current canonical transcript digest and cue count equal the binding.

Any mismatch is stale. A stale report is not returned to the player, and no
document report or report belonging to another variant may be substituted.

When a valid report is served, the server also issues an opaque playback token.
The first audio request creates a private copy-on-write snapshot (or a full copy
when cloning is unavailable), hashes it against the binding, and pins an open file
descriptor to that immutable snapshot. All later Range requests for the token read
the same descriptor. Replacing or rewriting the source path during playback cannot
silently switch the player to another M4B.

Authoritative eligibility checks stream and hash the current M4B bytes. A cached
digest derived from file size or modification time must not replace this check.

## Offline copies

Protocol v1 fails closed for downloaded/offline copies. The current iOS/offline
store cannot independently hash the native M4B bytes, so it does not cache or
display an analysis report. A future offline implementation may store a report
only after the device computes the local M4B SHA-256 and proves that it equals
the report binding. Refreshing server sidecars must never attach a newer report
to older downloaded M4B bytes.

## Changes

Any change to canonicalization, identity fields, or validation requires a new
protocol/digest algorithm identifier. Readers must fail closed on unknown
versions.
