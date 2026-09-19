#!/bin/sh
# Bring the bookshelf mirror up (or back up). Safe to run any time:
# `up -d` is a no-op when the container is already running and healthy.
# Handles the hung case too: if the container runs but health is failing,
# recreate it. No rebuild — for that, use redeploy.sh.
set -e
C=/volume1/System/bookshelf-server/compose.yml
STATUS=$(docker inspect --format '{{.State.Health.Status}}' bookforge-bookshelf 2>/dev/null || echo absent)
if [ "$STATUS" = "unhealthy" ]; then
  echo "container is unhealthy — recreating"
  docker compose -f "$C" up -d --force-recreate
else
  docker compose -f "$C" up -d
fi
sleep 3
curl -sf -m 10 http://127.0.0.1:8766/api/health && echo " <- mirror is answering" || { echo "MIRROR STILL NOT ANSWERING — docker logs bookforge-bookshelf"; exit 1; }
