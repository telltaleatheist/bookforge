# BookForge Catalog Indexer

A tiny job that keeps BookForge's list of downloadable **voices** and **language
packs** current — without hardcoding them in the app and without hosting the
model files.

It reads the same upstream sources the app downloads from, curates the result,
verifies it, and publishes `catalog.json` (+ `manifest.json`) to the repo's
`catalog-data` branch, served to the app via raw.githubusercontent.com:

```
https://raw.githubusercontent.com/telltaleatheist/bookforge/catalog-data/catalog.json
https://raw.githubusercontent.com/telltaleatheist/bookforge/catalog-data/manifest.json
```

## Why

The app used to hardcode voice/language lists (`electron/xtts-voices.ts`,
`electron/components/language-pack-components.ts`). That drifts: new voices appear
upstream and never show up; typo'd/duplicate folders and Stanza "phantom"
languages (no segmenter model) show up and fail to download. The indexer makes
the lists self-updating and self-verifying, so the app just fetches a curated,
always-current catalog (with the last-known-good list bundled as an offline
fallback in `electron/components/catalog.bundled.ts`).

It does **not** host model files. Voices download from HuggingFace; the indexer
only serves the *index*.

## Sources

| Kind | Source | Filter (verification) |
|------|--------|-----------------------|
| Voices | `huggingface.co/api/models/drewThomasson/fineTunedTTSModels` tree under `xtts-v2/<lang>/<voice>/` | folder must contain `config.json` + `model.pth` + `vocab.json` |
| Languages | `raw.githubusercontent.com/stanfordnlp/stanza-resources/main/resources_<ver>.json` | manifest entry must have a `tokenize` (segmenter) model — excludes phantom langs `bn/ml/or/si` |

## Curation

Languages aren't curated — display names come straight from the manifest's
`lang_name`. Voices are curated via `curation.json`:

- `voiceDeny` — hide junk / typo-duplicate folders (e.g. `JhonMulaney` →
  duplicate of `JohnMulaney`).
- `voiceRename` — override display names the CamelCase humanizer can't get right
  (franchise tags, ASMR spacing). Everything else is auto-spaced.

To add/remove a voice from the catalog, edit `curation.json` and rerun the Action.

## Files

| File | Role |
|------|------|
| `build_catalog.py` | The indexer. Fetch → verify → curate → atomic-write `catalog.json` + `manifest.json`. stdlib only. |
| `curation.json` | Hand-maintained voice denylist + rename map. |
| `releases.json` | Launcher/code/components/starter release data (written by `packaging/publish-release.js`). Merged into `manifest.json`. |

## Deployment (GitHub Actions)

Regeneration runs as the **`catalog-indexer`** workflow
(`.github/workflows/catalog-indexer.yml`): daily at 04:17 UTC, or on demand via
`workflow_dispatch`. It runs `build_catalog.py`, then commits the two generated
files to the `catalog-data` branch (creating it as an orphan branch on first
run). Pushing uses the workflow's `GITHUB_TOKEN` (`permissions: contents: write`).

Trigger a manual run:

```
gh workflow run catalog-indexer.yml --repo telltaleatheist/bookforge
```

(This replaces the old Triton cron that wrote `catalog.json`/`manifest.json` to
the owenmorgan.com docroot.)

## Safety

- **Sanity guard**: if a build yields < 20 voices or < 60 languages (upstream
  outage, API change), it aborts *without* overwriting the previous good
  catalog and exits non-zero, so the Action run fails (and notifies). No
  degraded publish.
- **Atomic write**: `catalog.json.tmp` → `os.replace`, so readers never see a
  partial file.
- **Retry/backoff**: transient HTTP failures (429/5xx/timeouts) retry with
  exponential backoff before giving up.

## Manual / local run

```
python3 build_catalog.py --dry-run                 # print catalog to stdout, don't write
python3 build_catalog.py --out catalog.json \
    --manifest-out manifest.json \
    --releases releases.json \
    --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"          # write both files locally
```

## Catalog schema (`schemaVersion: 1`)

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-30T19:15:34Z",
  "generator": "bookforge-catalog-indexer/1.0",
  "sources": { "voices": "...", "languages": "..." },
  "counts": { "voices": 40, "languages": 90 },
  "voices": [
    { "id": "ScarlettJohansson", "name": "Scarlett Johansson", "lang": "eng",
      "engine": "xtts", "repo": "drewThomasson/fineTunedTTSModels",
      "sub": "xtts-v2/eng/ScarlettJohansson/",
      "files": ["config.json", "model.pth", "vocab.json"],
      "ref": "ScarlettJohansson_24khz.wav", "sizeBytes": 1958123456 }
  ],
  "languages": [
    { "code": "de", "name": "German", "engine": "stanza", "sizeBytes": null }
  ]
}
```

`id`/`sub` are the exact HuggingFace folder coordinates — `download_model.py`
already accepts `--repo/--sub/--files`, so the app can download a catalog voice
with no preset-table entry.
