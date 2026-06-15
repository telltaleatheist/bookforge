#!/usr/bin/env python3
"""
BookForge catalog indexer.

Periodically (via cron on Triton) regenerates the list of downloadable XTTS
voices and Stanza language packs by reading the SAME upstream sources the app
downloads from — the HuggingFace repo tree for voices and the Stanza resources
manifest for languages — then curates the result and writes a single
`catalog.json` to the public mirror docroot.

This does NOT host the model files (those still come from HuggingFace, with the
owenmorgan.com mirror as a fallback). It only serves the *index* — the names,
ids, download coordinates (repo/sub/files), and sizes — so BookForge can stop
hardcoding the lists and instead pull a curated, always-current catalog.

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

# ── Output / mirror layout (Triton) ─────────────────────────────────────────
MIRROR_DOCROOT = "/home/owenmorgan/web/owenmorgan.com/public_html/bookforge"
DEFAULT_OUT = os.path.join(MIRROR_DOCROOT, "catalog.json")
# Folders under the mirror that hold actual fallback files, used only to flag
# which catalog entries have a mirror fallback. Absent on non-Triton runs.
MIRROR_VOICES_DIR = os.path.join(MIRROR_DOCROOT, "voices")
MIRROR_STANZA_DIR = os.path.join(MIRROR_DOCROOT, "stanza")

# Curation file (denylist + rename map) lives next to this script.
CURATION_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "curation.json")

SCHEMA_VERSION = 1
GENERATOR = "bookforge-catalog-indexer/1.0"

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
    mirrored = _list_dir(MIRROR_VOICES_DIR)

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
            "mirrored": voice in mirrored,
        })

    voices.sort(key=lambda v: (v["lang"] != "eng", v["lang"], v["name"].lower()))
    return voices, skipped


def build_languages():
    manifest, _ = _http_json(STANZA_MANIFEST)
    mirrored = _list_dir(MIRROR_STANZA_DIR)

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
            "mirrored": code in mirrored,
        })

    langs.sort(key=lambda l: l["name"].lower())
    return langs, sorted(phantoms)


def _list_dir(path):
    try:
        return set(os.listdir(path))
    except OSError:
        return set()


def _load_curation():
    try:
        with open(CURATION_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        sys.stderr.write(f"[catalog] no curation.json at {CURATION_PATH}; "
                         f"publishing un-curated\n")
        return {}


def _atomic_write(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)  # atomic on same filesystem


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=DEFAULT_OUT)
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

    if args.dry_run:
        sys.stdout.write(text)
        return 0

    _atomic_write(args.out, text)
    sys.stderr.write(f"[catalog] wrote {args.out} "
                     f"({len(text)} bytes)\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
