#!/bin/sh
# Smoke gate: `crowi-test-gcs` (fsouza/fake-gcs-server, docker-compose.yml)
# must stay opt-in. A plain `docker compose config --services` (the shape
# both a fresh developer's `docker compose up -d` and normal CI resolve
# against) must NOT list it; only `docker compose --profile gcs-test
# config --services` may. Exact whole-line matches only (`grep -Fx`) — a
# substring match would also accept an unrelated service whose name
# happens to contain "crowi-test-gcs" as a prefix/suffix.
#
# POSIX `sh` on purpose (invoked as `sh scripts/test-gcs-compose-profile.sh`,
# which ignores the shebang and forces POSIX interpretation) — no bashisms.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

SERVICE="crowi-test-gcs"

if docker compose config --services | grep -Fxq "$SERVICE"; then
  echo "✗ '$SERVICE' must NOT appear in the default 'docker compose config --services' list (it must stay opt-in via --profile gcs-test)" >&2
  exit 1
fi

if ! docker compose --profile gcs-test config --services | grep -Fxq "$SERVICE"; then
  echo "✗ '$SERVICE' must appear in 'docker compose --profile gcs-test config --services'" >&2
  exit 1
fi

echo "✓ '$SERVICE' is absent from the default compose service list and present only under --profile gcs-test."
