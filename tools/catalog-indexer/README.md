# BookForge Catalog Indexer

A tiny cron job that keeps BookForge's list of downloadable **voices** and
**language packs** current — without hardcoding them in the app and without
hosting the model files.

It reads the same upstream sources the app downloads from, curates the result,
verifies it, and publishes a single `catalog.json`:

```
https://owenmorgan.com/bookforge/catalog.json
```

## Why

The app used to hardcode voice/language lists (`electron/xtts-voices.ts`,
`electron/components/language-pack-components.ts`). That drifts: new voices appear
upstream and never show up; typo'd/duplicate folders and Stanza "phantom"
languages (no segmenter model) show up and fail to download. The indexer makes
the lists self-updating and self-verifying, so the app just fetches a curated,
always-current catalog (with the last-known-good list bundled as an offline
fallback).

It does **not** host model files. Voices still download from HuggingFace, with
the owenmorgan.com mirror as a fallback (the `mirrored` flag on each entry says
which items have that fallback). The indexer only serves the *index*.

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

To add/remove a voice from the catalog, edit `curation.json` and rerun.

## Files

| File | Role |
|------|------|
| `build_catalog.py` | The indexer. Fetch → verify → curate → atomic-write `catalog.json`. stdlib only. |
| `curation.json` | Hand-maintained voice denylist + rename map. |
| `run.sh` | Cron entrypoint: stamps UTC `generatedAt`, runs the indexer, appends to `catalog-indexer.log`. |

## Deployment (Triton)

```
/home/owenmorgan/bookforge-catalog/        # this directory, deployed
/home/owenmorgan/web/owenmorgan.com/public_html/bookforge/catalog.json   # output
```

Cron (daily 04:17 UTC):

```
17 4 * * * /home/owenmorgan/bookforge-catalog/run.sh
```

Redeploy after editing here:

```
scp -i ~/.ssh/triton build_catalog.py curation.json run.sh \
    triton:/home/owenmorgan/bookforge-catalog/
```

## Safety

- **Sanity guard**: if a build yields < 20 voices or < 60 languages (upstream
  outage, API change), it aborts *without* overwriting the previous good
  catalog and exits non-zero, so cron mails the failure. No degraded publish.
- **Atomic write**: `catalog.json.tmp` → `os.replace`, so readers never see a
  partial file.
- **Retry/backoff**: transient HTTP failures (429/5xx/timeouts) retry with
  exponential backoff before giving up.

## Manual run

```
./run.sh                          # build + publish, log to catalog-indexer.log
python3 build_catalog.py --dry-run   # print catalog to stdout, don't write
```

## Catalog schema (`schemaVersion: 1`)

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-15T16:34:18Z",
  "generator": "bookforge-catalog-indexer/1.0",
  "sources": { "voices": "...", "languages": "..." },
  "counts": { "voices": 40, "languages": 90 },
  "voices": [
    { "id": "ScarlettJohansson", "name": "Scarlett Johansson", "lang": "eng",
      "engine": "xtts", "repo": "drewThomasson/fineTunedTTSModels",
      "sub": "xtts-v2/eng/ScarlettJohansson/",
      "files": ["config.json", "model.pth", "vocab.json"],
      "sizeBytes": 1958123456, "mirrored": true }
  ],
  "languages": [
    { "code": "de", "name": "German", "engine": "stanza",
      "sizeBytes": null, "mirrored": true }
  ]
}
```

`id`/`sub` are the exact HuggingFace folder coordinates — `download_model.py`
already accepts `--repo/--sub/--files`, so the app can download a catalog voice
with no preset-table entry.
