# Deploying a Custom Orpheus Voice (New or Replacement)

Basic checklist for pushing a fine-tuned Orpheus voice out to BookForge. Covers
both adding a brand-new voice and re-pulling a retrained replacement for an
existing one.

## 1. Prepare the HF repo

Repo naming convention: `owenmorgan/<token>-orpheus-3b` (e.g. `owenmorgan/mistborn-orpheus-3b`).

The repo must contain the merged 16-bit HF checkpoint: `config.json` +
`*.safetensors` shard(s) + tokenizer files. No MLX conversion step needed —
MLX loads HF-format safetensors directly on Mac.

`README.md` **must** have YAML frontmatter with these keys (this is the only
place BookForge reads voice metadata from):

```yaml
---
license: apache-2.0
tags:
- bookforge-orpheus-voice
orpheus_token: mistborn        # the prompt token the model was fine-tuned on
label: Mistborn (Michael Kramer)
sample_rate: 24000
---
```

- `bookforge-orpheus-voice` tag marks it as a BookForge voice (required for the in-app catalog).
- `orpheus_token` is the thing we can't infer from the repo — get it right, it's the `--fine_tuned` prompt prefix.
- For a **replacement**, just push new weights to the same repo — same name, same token. No app-side code changes.
- For a **new** voice, pick a new `<token>-orpheus-3b` repo name and a unique `orpheus_token`.

## 2. Pull it into BookForge

**In-app (normal path):** Settings → Add-ons → Orpheus voices. New/updated
repos with the right tag show up automatically if they're in the source list
(`DEFAULT_ORPHEUS_SOURCES` in `electron/orpheus-hf-catalog.ts`, or add the repo
manually there). Click Install — this downloads and upserts `models.json` for you.

**Manual/CLI (e.g. scripting a batch of deploys, or the app isn't running):**

```bash
ENV_PY="$HOME/Library/Application Support/BookForge/runtime/e2a-env/bin/python"
DEST="$HOME/Library/Application Support/BookForge/runtime/orpheus-models/<token>"
export HF_TOKEN=$(cat ~/.config/bookforge/hf-owenmorgan.token)
"$ENV_PY" -u electron/scripts/orpheus_download.py "owenmorgan/<token>-orpheus-3b" "$DEST"
```

This overwrites any existing files in `DEST` (safe for replacements — unchanged
files keep their timestamp, changed weights get re-downloaded).

Then upsert the `models.json` entry by hand (only needed for the manual path —
the in-app installer does this automatically):

```
<orpheusModelsDir>/models.json
```

```json
{
  "id": "<token>",
  "label": "<label from README>",
  "token": "<orpheus_token from README>",
  "dir": "<token>",
  "format": "hf",
  "sampleRate": 24000,
  "source": { "type": "hf", "ref": "owenmorgan/<token>-orpheus-3b" },
  "license": "apache-2.0",
  "addedAt": "YYYY-MM-DD"
}
```

`orpheusModelsDir` defaults to `<userData>/runtime/orpheus-models`
(overridable in Settings → Tools, or `BOOKFORGE_ORPHEUS_MODELS_DIR` env var).
On Windows+WSL it's typically a `\\wsl$\...` path.

## 3. Verify

No app restart needed — `resolveOrpheusModel()` reads the manifest fresh each
call. Just pick the voice in the TTS settings and generate a test line.

## Notes

- The Python env used for the download is whatever `getPythonInvocation(e2aPath, 'orpheus')`
  resolves to (Settings → Add-ons → Orpheus component) — currently a conda
  *prefix* env at `runtime/e2a-env` on this Mac, not the separate
  `ebook2audiobook-orpheus` named conda env. Check `~/Library/Application
  Support/BookForge/components/installed.json` (`"orpheus"` entry) if unsure
  which env is wired up.
- HF token resolution order: Settings → `HF_TOKEN`/`HUGGING_FACE_HUB_TOKEN` env
  → `~/.config/bookforge/hf-owenmorgan.token` → `~/.cache/huggingface/token`.
