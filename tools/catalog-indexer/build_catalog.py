#!/usr/bin/env python3
"""
BookForge catalog indexer.

Periodically (via the catalog-indexer GitHub Action) regenerates the list of
downloadable XTTS voices and Stanza language packs by reading the SAME upstream
sources the app downloads from — the HuggingFace repo tree for voices and the
Stanza resources manifest for languages — then curates the result and writes
`catalog.json` (+ `manifest.json`) for publishing to the repo's `catalog-data`
branch, served to the app via raw.githubusercontent.com.

This does NOT host the model files (those come from HuggingFace). It only serves
the *index* — the names, ids, download coordinates (repo/sub/files), and sizes —
so BookForge can stop hardcoding the lists and instead pull a curated,
always-current catalog.

Design notes:
  - Voices and languages are derived from upstream, never hand-listed. The only
    hand-maintained input is `curation.json` (a denylist of junk/typo-duplicate
    voice folders + a display-name override map). Everything else is automatic:
    a new voice in the repo or a new Stanza language appears on the next run.
  - VERIFICATION happens here, at publish time, not on the user's machine. A
    voice is only published if its folder actually contains the three files the
    engine needs (config.json, model.pth, vocab.json). A language is only
    published if its manifest entry has a real `tokenize` (segmenter) model —
    this is what excludes Stanza "phantom" languages (bn/ml/or/si) that ship only
    character LMs and raise KeyError('packages') in stanza.download().
  - SANITY GUARD: if upstream is unreachable or returns an implausibly small set,
    the script aborts WITHOUT overwriting the previous good catalog and exits
    non-zero (so cron mails the failure). No fallback to a half-empty catalog.

Usage:
    python3 build_catalog.py                 # build + atomically publish
    python3 build_catalog.py --dry-run       # print to stdout, don't write
    python3 build_catalog.py --out PATH      # override output path
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

# ── Upstream sources ────────────────────────────────────────────────────────
VOICES_REPO = "drewThomasson/fineTunedTTSModels"
VOICES_ROOT = "xtts-v2"  # repo path holding <lang>/<voice>/ folders
HF_TREE = (
    f"https://huggingface.co/api/models/{VOICES_REPO}"
    f"/tree/main/{VOICES_ROOT}?recursive=true"
)

# Stanza manifest version — keep in sync with the version BookForge's bundled
# env downloads with. Bump here when the app's stanza is upgraded.
STANZA_VERSION = "1.10.0"
STANZA_MANIFEST = (
    f"https://raw.githubusercontent.com/stanfordnlp/stanza-resources/main"
    f"/resources_{STANZA_VERSION}.json"
)

# The three checkpoint files the XTTS engine needs from a fine-tuned voice
# folder. A reference clip is downloaded ALONGSIDE these (see pick_ref) so a
# downloaded voice is self-contained — no reliance on a bundled clip.
VOICE_FILES = ("config.json", "model.pth", "vocab.json")

# .wav names that are demos/training material, not a clean reference clip.
_BAD_REF_HINTS = ("generated_example", "_generated", "training", "dataset",
                  "converted", "example")


def pick_ref(voice_id, file_names):
    """Choose the best reference .wav from a voice folder's files. XTTS clones a
    voice from a short reference clip; we prefer a clean 24 kHz take, then a bare
    ref.wav, then the voice-named clip, then lower sample rates. Returns the
    filename, or None if the folder has no usable clip (the voice is then
    skipped — it can't be downloaded into a working state without a reference)."""
    vid = voice_id.lower()
    wavs = [f for f in file_names if f.lower().endswith(".wav")]
    clean = [w for w in wavs if not any(b in w.lower() for b in _BAD_REF_HINTS)]
    candidates = clean or wavs  # fall back to any wav only if nothing cleaner

    def score(w):
        wl = w.lower()
        if wl == f"{vid}_24khz.wav": return 0
        if wl == f"{vid}_24000.wav": return 1
        if wl == "ref.wav": return 2
        if wl == f"{vid}.wav": return 3
        if wl == f"{vid}_22khz.wav": return 4
        if wl == f"{vid}_16000.wav": return 5
        if "24khz" in wl or "24000" in wl: return 6
        if wl.startswith("ref"): return 7
        return 8

    candidates.sort(key=lambda w: (score(w), len(w)))
    return candidates[0] if candidates else None

# ── Output layout ───────────────────────────────────────────────────────────
# Defaults write to the current directory; the GitHub Action passes explicit
# --out / --manifest-out paths and publishes them to the `catalog-data` branch.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = "catalog.json"

# Curation file (denylist + rename map) lives next to this script.
CURATION_PATH = os.path.join(SCRIPT_DIR, "curation.json")

SCHEMA_VERSION = 1
GENERATOR = "bookforge-catalog-indexer/1.0"

# manifest.json (schemaVersion 2) is a SUPERSET of catalog.json: the same voices/languages
# PLUS the three update tiers (launcher / code / components). The voices/languages come from
# upstream here (cron); the launcher/code/components come from releases.json, which is written
# only by the build machine's publish step (packaging/publish-release.js). Reading it here and
# voices there keeps the two writers race-free.
MANIFEST_SCHEMA_VERSION = 2
APP_NAME = "bookforge"
DEFAULT_MANIFEST_OUT = "manifest.json"
DEFAULT_RELEASES = os.path.join(SCRIPT_DIR, "releases.json")

# Sanity floors — if a build produces fewer than these, something is wrong
# upstream; abort rather than publish a degraded catalog.
MIN_VOICES = 20
MIN_LANGUAGES = 60


# ── HTTP helpers (stdlib only, with transient-retry) ────────────────────────
def _is_transient(exc):
    if isinstance(exc, (urllib.error.URLError, ConnectionError, TimeoutError)):
        return True
    msg = str(exc).lower()
    return any(s in msg for s in (
        "429", "too many requests", "rate limit", "timed out", "timeout",
        "connection reset", "connection aborted", "temporarily unavailable",
        "500", "502", "503", "504", "remote end closed",
    ))


def _http_json(url, *, attempts=4, base_delay=2.0):
    """GET url and parse JSON, retrying transient failures with backoff. Returns
    (data, response_headers). Re-raises after the final attempt."""
    last = None
    for i in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": GENERATOR,
                "Accept": "application/json",
            })
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.load(resp), resp.headers
        except Exception as e:  # noqa: BLE001
            last = e
            if not _is_transient(e) or i == attempts:
                raise
            delay = base_delay * (2 ** (i - 1))
            sys.stderr.write(f"[catalog] {url} attempt {i}/{attempts} failed "
                             f"({e}); retry in {delay:.0f}s\n")
            time.sleep(delay)
    raise last


def _hf_tree(url):
    """Fetch a HuggingFace tree listing, following cursor pagination (the API
    caps each page and signals more via a Link: rel="next" header)."""
    entries = []
    next_url = url
    while next_url:
        page, headers = _http_json(next_url)
        entries.extend(page)
        link = headers.get("Link", "") or ""
        m = re.search(r'<([^>]+)>;\s*rel="next"', link)
        next_url = m.group(1) if m else None
    return entries


# ── Display-name humanizer ──────────────────────────────────────────────────
def humanize(name):
    """CamelCase / run-on folder name → spaced display name.
    'ScarlettJohansson' → 'Scarlett Johansson'; 'ASMRCuteDragon' → 'ASMR Cute
    Dragon'. Curation overrides win over this for the awkward franchise names."""
    s = re.sub(r'(?<=[a-z0-9])(?=[A-Z])', ' ', name)      # word|Word
    s = re.sub(r'(?<=[A-Z])(?=[A-Z][a-z])', ' ', s)        # ACRONYM|Word
    return s.strip()


# ── Builders ────────────────────────────────────────────────────────────────
def build_voices(curation):
    deny = set(curation.get("voiceDeny", []))
    rename = curation.get("voiceRename", {})

    # Group every file in the tree by (lang, voice).
    by_voice = {}
    for e in _hf_tree(HF_TREE):
        if e.get("type") != "file":
            continue
        parts = e["path"].split("/")          # xtts-v2/<lang>/<voice>/<file>
        if len(parts) < 4:
            continue
        lang, voice, fname = parts[1], parts[2], parts[-1]
        by_voice.setdefault((lang, voice), {})[fname] = e.get("size", 0)

    voices = []
    skipped = []
    for (lang, voice), files in sorted(by_voice.items()):
        if voice in deny:
            skipped.append(f"{lang}/{voice} (denylisted)")
            continue
        # VERIFY: must have all three engine files present in the tree.
        missing = [f for f in VOICE_FILES if f not in files]
        if missing:
            skipped.append(f"{lang}/{voice} (missing {','.join(missing)})")
            continue
        # VERIFY: must have a usable reference clip to download with the model.
        ref = pick_ref(voice, files.keys())
        if not ref:
            skipped.append(f"{lang}/{voice} (no reference .wav)")
            continue
        size = sum(files.get(f, 0) for f in VOICE_FILES) + files.get(ref, 0)
        voices.append({
            "id": voice,                       # == HF folder == engine preset id
            "name": rename.get(voice) or humanize(voice),
            "lang": lang,
            "engine": "xtts",
            "repo": VOICES_REPO,
            "sub": f"{VOICES_ROOT}/{lang}/{voice}/",
            "files": list(VOICE_FILES),
            "ref": ref,                        # reference clip filename in the folder
            "sizeBytes": size,
        })

    voices.sort(key=lambda v: (v["lang"] != "eng", v["lang"], v["name"].lower()))
    return voices, skipped


def build_languages():
    manifest, _ = _http_json(STANZA_MANIFEST)

    langs = []
    phantoms = []
    for code, entry in manifest.items():
        if not isinstance(entry, dict) or "lang_name" not in entry:
            continue  # skip meta keys ('url', 'multilingual') and name aliases
        # VERIFY: a real sentence-segmentation model must exist. Phantom langs
        # (charlm-only) have no 'tokenize' and crash stanza.download().
        if "tokenize" not in entry:
            phantoms.append(code)
            continue
        langs.append({
            "code": code,
            "name": entry["lang_name"].replace("_", " "),
            "engine": "stanza",
            "sizeBytes": None,   # true size reported by the downloader's progress
        })

    langs.sort(key=lambda l: l["name"].lower())
    return langs, sorted(phantoms)


def _load_curation():
    try:
        with open(CURATION_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        sys.stderr.write(f"[catalog] no curation.json at {CURATION_PATH}; "
                         f"publishing un-curated\n")
        return {}


def _load_releases(path):
    """Release data (launcher/code/components) maintained by the publish step. Absent until the
    first release is published — in which case manifest.json is simply not (re)written."""
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None


def build_manifest(catalog, releases, now):
    """Assemble manifest.json (v2) = catalog content + the release tiers from releases.json.
    Pure (no I/O) so it's unit-testable without hitting upstream."""
    manifest = {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "app": APP_NAME,
        "generatedAt": now or "1970-01-01T00:00:00Z",
        "generator": GENERATOR,
        "launcher": releases.get("launcher", {"version": "0.0.0", "platforms": {}}),
        "code": releases.get("code", {}),
        "components": releases.get("components", []),
        "sources": catalog["sources"],
        "counts": catalog["counts"],
        "voices": catalog["voices"],
        "languages": catalog["languages"],
    }
    # Optional one-time starter library (downloaded into an empty library on first run).
    starter = (releases or {}).get("starter")
    if starter and starter.get("url"):
        manifest["starter"] = starter
    return manifest


def _releases_has_code(releases):
    code = (releases or {}).get("code") or {}
    return bool(code.get("version") and code.get("url"))


def _releases_has_starter(releases):
    starter = (releases or {}).get("starter") or {}
    return bool(starter.get("url") and starter.get("sha256"))


def _atomic_write(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)  # atomic on same filesystem


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--manifest-out", default=DEFAULT_MANIFEST_OUT)
    ap.add_argument("--releases", default=DEFAULT_RELEASES)
    ap.add_argument("--dry-run", action="store_true")
    # generatedAt is injected by the caller (cron passes UTC) so the script is
    # reproducible and testable; falls back to a fixed placeholder if absent.
    ap.add_argument("--now", default=os.environ.get("CATALOG_NOW", ""))
    args = ap.parse_args()

    curation = _load_curation()
    voices, voices_skipped = build_voices(curation)
    languages, phantoms = build_languages()

    # SANITY GUARD — never publish a degraded catalog over a good one.
    if len(voices) < MIN_VOICES or len(languages) < MIN_LANGUAGES:
        sys.stderr.write(
            f"[catalog] ABORT: implausible counts (voices={len(voices)} "
            f"< {MIN_VOICES} or languages={len(languages)} < {MIN_LANGUAGES}). "
            f"Upstream problem; keeping previous catalog.\n")
        return 2

    catalog = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": args.now or "1970-01-01T00:00:00Z",
        "generator": GENERATOR,
        "sources": {
            "voices": f"huggingface:{VOICES_REPO}/{VOICES_ROOT}",
            "languages": f"stanza-resources:resources_{STANZA_VERSION}.json",
        },
        "counts": {"voices": len(voices), "languages": len(languages)},
        "voices": voices,
        "languages": languages,
    }
    text = json.dumps(catalog, ensure_ascii=False, indent=2) + "\n"

    sys.stderr.write(
        f"[catalog] voices: {len(voices)} published, "
        f"{len(voices_skipped)} skipped {voices_skipped or ''}\n"
        f"[catalog] languages: {len(languages)} published, "
        f"phantoms excluded: {phantoms}\n")

    # Assemble manifest.json (superset) if release data is available.
    releases = _load_releases(args.releases)
    manifest_text = None
    if _releases_has_code(releases) or _releases_has_starter(releases):
        manifest = build_manifest(catalog, releases, args.now)
        manifest_text = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    else:
        sys.stderr.write(
            f"[catalog] no/incomplete releases.json at {args.releases}; "
            f"manifest.json not written (catalog.json still published)\n")

    if args.dry_run:
        sys.stdout.write(text)
        if manifest_text:
            sys.stderr.write("[catalog] --- manifest.json (dry-run) below ---\n")
            sys.stdout.write(manifest_text)
        return 0

    _atomic_write(args.out, text)
    sys.stderr.write(f"[catalog] wrote {args.out} "
                     f"({len(text)} bytes)\n")
    if manifest_text:
        _atomic_write(args.manifest_out, manifest_text)
        sys.stderr.write(f"[catalog] wrote {args.manifest_out} "
                         f"({len(manifest_text)} bytes)\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
