# Titan runbook — the NAS bookshelf mirror

The UGREEN NAS (**titan**, `192.168.68.125`) serves the bookshelf web app and
audiobook streaming straight off its own disk, so the shelf stays up when
BookForge is closed on the PC and the Mac. It is the REAL compiled
`BookshelfServer` in standalone mode (see `README.md` beside this file), run
headless by `cli/serve-bookshelf.js` inside Docker.

**URL: `http://192.168.68.125:8766`** — port 8766, not 8765, because UGOS's own
`fio` file service owns 8765 on the NAS. Over the tailnet it is
`http://titan.owenmorgan.com:8766` — that hostname resolves ONLY through
Tailscale's DNS (public and router DNS say non-existent), so a phone must have
Tailscale connected to use it; on home wifi use the IP.

## Where everything lives on titan

Everything is under **`/volume1/System/bookshelf-server/`** — the area that
survives UGOS firmware updates:

| Path | What |
|---|---|
| `compose.yml` | The compose file actually in use (titan-adapted: port 8766, library on volume3, memory limits, janitor sidecar). **This file is edited in place on titan — it is NOT a copy of the repo's `docker-compose.yml`.** |
| — | **Mirrored in git** at `deploy/bookshelf-server/titan/` since 2026-08-25, so a wiped NAS does not take them with it. The copies there are a BACKUP, not the source: titan's are still the ones that run, so edit titan's and re-capture, never the reverse (see the gotcha below). |
| `context/` | The staged build context (dist + cli + Dockerfile), extracted from the tarball below |
| `bookshelf-server-context.tgz` | The last context tarball scp'd from the PC |
| `redeploy.sh` | Re-extract + `docker compose build` + `up -d` (full update) |
| `up.sh` | Bring it up / recreate if unhealthy (no rebuild) |
| `state/` | Per-machine server state: duration cache, cover thumbnails, device id |

The library itself is `/volume3/iO/bookforge` (the `iO` share = `Z:` on the PC),
mounted read-write into the container at `/library` — read-write because reader
positions/bookmarks live under `<library>/.bookshelf/` as per-device files.

Two containers run: `bookforge-bookshelf` (the server) and
`bookforge-tmp-janitor` (sweeps kernel core dumps out of titan's 3.8 GB `/tmp`
tmpfs — 196k smbd cores once filled it and took the NAS's daemons down).

## Deploying an update

All from the PC. The image is never built from source on titan — the PC
builds, titan just packages and runs.

**Build in a STAGING DIR cut from a sha, not in the working checkout.** Two
reasons, both paid for on 2026-08-25/26: a deploy built from a working tree can
carry uncommitted bytes (titan served code that existed in no commit for
hours), and `dist/` is shared — `build:electron` opens with `rm -rf
dist/electron`, so two agents building out of one checkout can ship or run a
half-written tree, with no git evidence afterwards because dist/ has no branch
and no reflog. Staging from a sha closes both: the sources are exactly one
commit's, and the stage owns its dist/ outright.

```sh
# 0. (first time only) make the persistent stage and install deps
STAGE=<somewhere outside the checkout>
git archive origin/main | tar -x -C "$STAGE" && (cd "$STAGE" && npm ci)

# 1. Refresh sources + build. Re-extract OVERWRITES tracked files and leaves
#    node_modules alone — tar only writes the paths in the archive (verified).
git archive <sha> | tar -x -C "$STAGE"
cd "$STAGE" && npm run build:electron

# 2. Stage the context tarball (~4 MB) and ship it
S=$TMP  # any scratch dir
tar --force-local -czf "$S/bookshelf-server-context.tgz" \
  package.json package-lock.json cli deploy/bookshelf-server dist/electron dist/shared
scp "$S/bookshelf-server-context.tgz" titan:/volume1/System/bookshelf-server/

# 3. Rebuild + restart on titan
ssh titan "sh /volume1/System/bookshelf-server/redeploy.sh"

# 4. Verify — and note WHICH sha you deployed
curl http://192.168.68.125:8766/api/health
# → {"status":"ok","name":"titan","capabilities":["library","reader","pdf"]}
```

Known edges of the staged flow (measured, 2026-08-26): a re-extract never
DELETES a file a later commit removed, so a long-lived stage slowly accumulates
ghosts — tolerable for a deploy stage; when it matters, wipe the stage and
re-run step 0 rather than getting clever. Never junction node_modules from the
main checkout into the stage (see Worktree Hygiene in CLAUDE.md — a junction
plus recursive cleanup once gutted the main checkout's real node_modules). The
`npm ci` half of step 0 is the one part not yet run on this PC; everything
through the archive/extract behaviour is verified.

Web clients pick the new UI up on next page load. The **native iOS app bundles
its own copy of the UI** and only changes when the app itself is rebuilt.

**Gotcha (bitten once):** if you regenerate `compose.yml` locally and scp it
over, you clobber titan's in-place edits — the port regresses 8766→8765 and the
container fails to start with "address already in use". Titan's `compose.yml`
is the authority; edit it there, or diff before overwriting.

That is also why `deploy/bookshelf-server/titan/` is a mirror and not a source.
To refresh it after changing something on titan:

```sh
for f in compose.yml redeploy.sh up.sh; do
  scp titan:/volume1/System/bookshelf-server/$f deploy/bookshelf-server/titan/$f
done
git diff deploy/bookshelf-server/titan/    # read it before committing
```

**Deploy from a COMMIT, not from a working tree.** On 2026-08-25 the mirror was
rebuilt several times from uncommitted changes, so for a few hours titan served
code that existed in no commit anywhere and no sha described what was running.
Stage the context from a clean tree, or note the sha you built.

## If it's down

In escalating order:

1. **Usually it isn't your job.** `restart: unless-stopped` restarts a crashed
   server, and UGOS auto-starts dockerd after reboots and firmware updates.
   Give it a minute.
2. **The kick** — either double-click **"Restart Titan Bookshelf.cmd"** on the
   PC desktop, or from any machine (Termius on the phone works):
   ```sh
   ssh titan "sh /volume1/System/bookshelf-server/up.sh"
   ```
   Safe to run any time: no-op when healthy, plain start when stopped, forced
   recreate when Docker reports the container unhealthy. Ends by curling the
   health endpoint and saying what it found.
3. **Look at why:**
   ```sh
   ssh titan "docker ps -a --filter name=bookforge"
   ssh titan "docker logs --since 30m bookforge-bookshelf | tail -50"
   ```
   Known failure shapes:
   - `FATAL ERROR: ... heap out of memory` — the container has a 4 GB node heap
     inside a 5 GB cap for exactly this; if it recurs, something regressed.
   - `bind: address already in use` — the compose port mapping regressed to
     8765 (see the gotcha above); fix `ports:` in titan's `compose.yml` to
     `"8766:8765"` and `up -d`.
   - Everything flaky at once, healthchecks failing with `no space left on
     device` — titan's `/tmp` filled with core dumps again; the janitor should
     prevent it, but the manual sweep is
     `ssh titan "sudo find /tmp -maxdepth 1 -name 'core.*' -delete"`
     (must be `find` — at six figures of files a shell glob overflows argv).
4. **Full redeploy** (step 3 of "Deploying an update") rebuilds the image from
   the last staged context without needing the PC to rebuild anything.

## Access facts

- `ssh titan` works keyless from the PC as `owenmorgan`.
- `owenmorgan` is in the `docker` group (daemon needs no sudo) and has
  passwordless sudo (`/etc/sudoers.d/owenmorgan`).
- **UGOS firmware updates wipe system files.** The containers, their restart
  policies, and everything under `/volume1/System/` survive; the sudoers file
  and docker-group membership may not. If an update takes them, one root
  session restores both:
  ```sh
  usermod -aG docker owenmorgan
  echo 'owenmorgan ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/owenmorgan && \
    chmod 440 /etc/sudoers.d/owenmorgan && visudo -c
  ```
