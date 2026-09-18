#!/bin/sh
# Deploy the bookshelf mirror to titan from ONE commit — the runbook in TITAN.md
# ("Deploying an update") as a single command, so none of its steps can be
# skipped or misordered by hand.
#
#   npm run deploy:titan -- <sha|ref>        # e.g. HEAD, origin/main, 97af8c3d
#
# What it enforces, and why (each one was paid for, see TITAN.md):
#   · The ref must already be on origin/main. Titan only ever serves committed,
#     pushed code — never a working tree, never a local-only commit — so the sha
#     it prints is one anyone can check out.
#   · The build happens in a STAGE outside the checkout, cut with `git archive`
#     from that sha. The stage holds exactly one commit's bytes and owns its own
#     dist/, so a build can neither carry uncommitted edits nor race a build in
#     the working checkout (build:electron opens with rm -rf dist/electron).
#   · Everything but node_modules is wiped before the extract, so a file a later
#     commit deleted cannot linger in the stage as a ghost.
#   · BOOKFORGE_BUILD_SHA / _COUNT are set here — stamp-build refuses to stamp a
#     tree with no .git and no override, and forgetting them was the first thing
#     that went wrong with the staged flow.
#   · Titan's compose.yml is never touched. Only the context tarball moves.
#
# Runs from any machine that can `ssh titan` (the Mac and the PC both can).
# Override the stage location with BOOKFORGE_TITAN_STAGE.
set -eu

REF=${1:-}
if [ -z "$REF" ]; then
  echo "usage: npm run deploy:titan -- <sha|ref>   (e.g. HEAD, origin/main)" >&2
  exit 2
fi

REPO=$(cd "$(dirname "$0")/../.." && pwd)
TITAN_HOST=${BOOKFORGE_TITAN_HOST:-titan}
TITAN_DIR=/volume1/System/bookshelf-server
HEALTH_URL=${BOOKFORGE_TITAN_HEALTH:-http://192.168.68.125:8766/api/health}

if [ -n "${BOOKFORGE_TITAN_STAGE:-}" ]; then
  STAGE=$BOOKFORGE_TITAN_STAGE
elif [ -d /Volumes/Callisto/Projects ]; then
  STAGE=/Volumes/Callisto/Projects/bookforge-titan-stage
else
  STAGE=$HOME/bookforge-titan-stage
fi
case "$STAGE" in
  "$REPO"|"$REPO"/*) echo "refusing: stage $STAGE is inside the checkout" >&2; exit 2 ;;
esac

say() { printf '\n[deploy:titan] %s\n' "$*"; }

# ── 1. Resolve the ref and prove it is on origin/main ────────────────────────
say "fetching origin"
git -C "$REPO" fetch --quiet origin
SHA=$(git -C "$REPO" rev-parse --verify "$REF^{commit}")
SHORT=$(git -C "$REPO" rev-parse --short "$SHA")
COUNT=$(git -C "$REPO" rev-list --count "$SHA")
if ! git -C "$REPO" merge-base --is-ancestor "$SHA" origin/main; then
  echo "refusing: $SHORT is not on origin/main — push it first, then deploy." >&2
  echo "          (titan serves only code that exists on origin)" >&2
  exit 1
fi
SUBJECT=$(git -C "$REPO" log -1 --format=%s "$SHA")
say "deploying $SHORT (#$COUNT): $SUBJECT"

# ── 2. Stage exactly that commit ─────────────────────────────────────────────
mkdir -p "$STAGE"
say "staging into $STAGE"
# Wipe everything except node_modules so no ghost from an earlier extract
# survives; tar only writes the paths in the archive and never deletes.
find "$STAGE" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
git -C "$REPO" archive "$SHA" | tar -x -C "$STAGE"

# npm ci only when the lockfile the stage was installed from has changed.
LOCK_SUM=$(shasum -a 256 "$STAGE/package-lock.json" | cut -d' ' -f1)
if [ ! -d "$STAGE/node_modules" ] || [ "$(cat "$STAGE/node_modules/.bookforge-lock-sha256" 2>/dev/null)" != "$LOCK_SUM" ]; then
  say "package-lock changed (or first run) — npm ci"
  (cd "$STAGE" && npm ci)
  printf '%s' "$LOCK_SUM" > "$STAGE/node_modules/.bookforge-lock-sha256"
else
  say "node_modules matches package-lock — skipping npm ci"
fi

# ── 3. Build, stamped with the sha the stage was cut from ────────────────────
say "build:electron"
(cd "$STAGE" && BOOKFORGE_BUILD_SHA="$SHORT" BOOKFORGE_BUILD_COUNT="$COUNT" npm run build:electron)
for must in dist/electron/bookshelf-server.js dist/electron/bookshelf-ui/index.html dist/shared cli/serve-bookshelf.js; do
  [ -e "$STAGE/$must" ] || { echo "build did not produce $must" >&2; exit 1; }
done

# ── 4. Ship the context tarball and rebuild on titan ─────────────────────────
TGZ=$STAGE/bookshelf-server-context.tgz
say "packing context"
(cd "$STAGE" && tar -czf "$TGZ" \
  package.json package-lock.json cli deploy/bookshelf-server dist/electron dist/shared)
say "scp → $TITAN_HOST:$TITAN_DIR/  ($(du -h "$TGZ" | cut -f1))"
scp -q "$TGZ" "$TITAN_HOST:$TITAN_DIR/bookshelf-server-context.tgz"
say "redeploy on titan (docker compose build + up)"
ssh "$TITAN_HOST" "sh $TITAN_DIR/redeploy.sh"

# ── 5. Verify, and leave a record of what is running ─────────────────────────
say "waiting for /api/health"
i=0
until curl -sf -m 5 "$HEALTH_URL" >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -ge 30 ]; then
    echo "titan is not answering at $HEALTH_URL after 60s — see TITAN.md 'If it's down'" >&2
    exit 1
  fi
  sleep 2
done
ssh "$TITAN_HOST" "printf '%s %s %s\n' '$SHA' '$(date -u +%Y-%m-%dT%H:%M:%SZ)' '$(echo "$SUBJECT" | tr -d "'")' > $TITAN_DIR/DEPLOYED_SHA"
say "titan is now serving $SHORT — $(curl -s -m 5 "$HEALTH_URL")"
