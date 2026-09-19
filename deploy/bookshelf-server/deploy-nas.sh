#!/bin/sh
# Deploy the bookshelf mirror to the NAS from ONE commit — the runbook in NAS.md
# ("Deploying an update") as a single command, so none of its steps can be
# skipped or misordered by hand.
#
#   npm run deploy:nas -- <sha|ref>        # e.g. HEAD, origin/main, 97af8c3d
#
# What it enforces, and why (each one was paid for, see NAS.md):
#   · The ref must already be on origin/main. NAS only ever serves committed,
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
#   · NAS's compose.yml is never touched. Only the context tarball moves.
#
# Runs from any machine that can `ssh $BOOKFORGE_NAS_HOST`.
# Override the stage location with BOOKFORGE_NAS_STAGE.
#
# ── WHERE THE NAS'S NAME AND ADDRESS COME FROM ──────────────────────────────
#
# Not from here. A machine's name and address are facts owned by THAT machine's
# config, and this repo is public — a hostname baked into a tracked script goes
# stale the day the box moves and publishes the operator's network in the
# meantime. So both are REQUIRED environment variables, normally set once in
# `deploy/bookshelf-server/.env` (untracked; copy `.env.example`). Missing means
# a refusal by name, never a guess: a default host would deploy this tree to
# whatever machine happens to answer to it.
set -eu

REF=${1:-}
if [ -z "$REF" ]; then
  echo "usage: npm run deploy:nas -- <sha|ref>   (e.g. HEAD, origin/main)" >&2
  exit 2
fi

REPO=$(cd "$(dirname "$0")/../.." && pwd)
ENV_FILE=$(dirname "$0")/.env
if [ -f "$ENV_FILE" ]; then
  . "$ENV_FILE"
fi
if [ -z "${BOOKFORGE_NAS_HOST:-}" ]; then
  echo "refusing: BOOKFORGE_NAS_HOST is not set — this script does not know which machine" >&2
  echo "          to deploy to, and will not guess. Copy deploy/bookshelf-server/.env.example" >&2
  echo "          to .env beside it and fill in your NAS's ssh host, or export it." >&2
  exit 2
fi
if [ -z "${BOOKFORGE_NAS_HEALTH:-}" ]; then
  echo "refusing: BOOKFORGE_NAS_HEALTH is not set — the deploy verifies the new container by" >&2
  echo "          curling it, and the URL is this machine's fact, not the repo's. Set it in" >&2
  echo "          deploy/bookshelf-server/.env (see .env.example)." >&2
  exit 2
fi
NAS_HOST=$BOOKFORGE_NAS_HOST
NAS_DIR=/volume1/System/bookshelf-server
HEALTH_URL=$BOOKFORGE_NAS_HEALTH

if [ -n "${BOOKFORGE_NAS_STAGE:-}" ]; then
  STAGE=$BOOKFORGE_NAS_STAGE
elif [ -d /Volumes/Callisto/Projects ]; then
  STAGE=/Volumes/Callisto/Projects/bookforge-nas-stage
else
  STAGE=$HOME/bookforge-nas-stage
fi
case "$STAGE" in
  "$REPO"|"$REPO"/*) echo "refusing: stage $STAGE is inside the checkout" >&2; exit 2 ;;
esac

say() { printf '\n[deploy:nas] %s\n' "$*"; }

# ── 1. Resolve the ref and prove it is on origin/main ────────────────────────
say "fetching origin"
git -C "$REPO" fetch --quiet origin
SHA=$(git -C "$REPO" rev-parse --verify "$REF^{commit}")
SHORT=$(git -C "$REPO" rev-parse --short "$SHA")
COUNT=$(git -C "$REPO" rev-list --count "$SHA")
if ! git -C "$REPO" merge-base --is-ancestor "$SHA" origin/main; then
  echo "refusing: $SHORT is not on origin/main — push it first, then deploy." >&2
  echo "          (nas serves only code that exists on origin)" >&2
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

# ── 4. Ship the context tarball and rebuild on the NAS ─────────────────────────
TGZ=$STAGE/bookshelf-server-context.tgz
say "packing context"
(cd "$STAGE" && tar -czf "$TGZ" \
  package.json package-lock.json vendor cli deploy/bookshelf-server dist/electron dist/shared)
say "upload → $NAS_HOST:$NAS_DIR/  ($(du -h "$TGZ" | cut -f1))"
# Streamed over plain ssh, not scp: OpenSSH ≥ 9 scp speaks SFTP by default and
# the NAS's sftp subsystem answers "dest open: No such file or directory" for a
# directory that exists (2026-09-18). Piping into cat needs nothing of the
# remote but a shell, from any OpenSSH on either machine. Written to a .tmp
# and renamed, so a broken upload never replaces the last good tarball.
REMOTE_TGZ=$NAS_DIR/bookshelf-server-context.tgz
ssh "$NAS_HOST" "cat > $REMOTE_TGZ.tmp && mv -f $REMOTE_TGZ.tmp $REMOTE_TGZ" < "$TGZ"
say "redeploy on the NAS (docker compose build + up)"
ssh "$NAS_HOST" "sh $NAS_DIR/redeploy.sh"

# ── 5. Verify, and leave a record of what is running ─────────────────────────
say "waiting for /api/health"
i=0
until curl -sf -m 5 "$HEALTH_URL" >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -ge 30 ]; then
    echo "nas is not answering at $HEALTH_URL after 60s — see NAS.md 'If it's down'" >&2
    exit 1
  fi
  sleep 2
done
ssh "$NAS_HOST" "printf '%s %s %s\n' '$SHA' '$(date -u +%Y-%m-%dT%H:%M:%SZ)' '$(echo "$SUBJECT" | tr -d "'")' > $NAS_DIR/DEPLOYED_SHA"
say "nas is now serving $SHORT — $(curl -s -m 5 "$HEALTH_URL")"
