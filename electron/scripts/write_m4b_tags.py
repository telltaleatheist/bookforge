#!/usr/bin/env python3
"""Write MP4/M4B tags + cover art IN PLACE using mutagen.

Unlike an ffmpeg `-c copy` remux (which rewrites the entire file — every audio
byte — to a new file and swaps it), mutagen edits only the metadata atoms in the
existing file. No audio re-encode, no full-file copy, so a tag/cover change on a
500 MB audiobook is near-instant instead of a multi-minute rewrite. Chapters and
the audio bitstream are left untouched.

Reads a JSON payload on stdin:
  {"file": "<abs .m4b>",
   "tags": {"title","artist","composer","grouping","genre","date","description"},
   "cover": "<abs image path>" | null}

Prints exactly one JSON line: {"ok": true} or {"ok": false, "error": "..."}.

Transient file locks (OneDrive/Syncthing syncing the file, a player holding it)
are retried with backoff before giving up — the same class of EBUSY/sharing
violation the ffmpeg swap path hits on cloud-synced drives.
"""
import sys
import json
import time
import errno

# iTunes/MP4 atom names for the fields BookForge edits. Narrator -> composer and
# series -> grouping match the long-standing m4b-tool / ffmpeg mapping.
KEYMAP = {
    "title": "\xa9nam",
    "artist": "\xa9ART",
    "composer": "\xa9wrt",
    "grouping": "\xa9grp",
    "genre": "\xa9gen",
    "date": "\xa9day",
    "description": "desc",
}


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": "bad payload: %s" % e}))
        return

    path = payload.get("file")
    tags = payload.get("tags") or {}
    cover = payload.get("cover")
    if not path:
        print(json.dumps({"ok": False, "error": "no file path given"}))
        return

    try:
        from mutagen.mp4 import MP4, MP4Cover
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": "mutagen unavailable: %s" % e}))
        return

    def attempt():
        mp4 = MP4(path)
        if mp4.tags is None:
            mp4.add_tags()
        for field, atom in KEYMAP.items():
            value = tags.get(field)
            if value is None or value == "":
                continue
            mp4.tags[atom] = [str(value)]
        # iTunes "audiobook" media kind so players treat it correctly.
        mp4.tags["stik"] = [2]
        if cover:
            with open(cover, "rb") as fh:
                data = fh.read()
            fmt = (MP4Cover.FORMAT_PNG if cover.lower().endswith(".png")
                   else MP4Cover.FORMAT_JPEG)
            mp4.tags["covr"] = [MP4Cover(data, imageformat=fmt)]
        mp4.save()

    last = None
    # First try is immediate; then back off to ride out a transient lock.
    for delay in (0, 0.3, 0.6, 1.2, 2.0):
        if delay:
            time.sleep(delay)
        try:
            attempt()
            print(json.dumps({"ok": True}))
            return
        except PermissionError as e:  # Windows sharing violation while synced.
            last = e
            continue
        except OSError as e:
            last = e
            if getattr(e, "errno", None) in (errno.EACCES, errno.EBUSY, errno.EPERM):
                continue
            print(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}))
            return
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}))
            return

    print(json.dumps({"ok": False,
                      "error": "file locked after retries (sync/player holding it): %s" % last}))


if __name__ == "__main__":
    main()
