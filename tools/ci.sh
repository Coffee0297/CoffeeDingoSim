#!/usr/bin/env bash
# Headless regression run for CI (Linux). No dingoConfig and no vcan needed: the simulator talks to Renode over
# the bank (:7800) and bridge (:7777) TCP links only.
#
#   tools/ci.sh <scene-dir> <firmware-build-dir> [golden-run.json]
#
# Exit code: 0 = replay matches the golden run within tolerance, 1 = diff, 2 = setup failure.
set -euo pipefail

SCENE_DIR="${1:?scene dir, e.g. scenes/example}"
FW_DIR="${2:?firmware build dir containing dingopdm_v7.elf canboard_v2.elf ...}"
GOLDEN="${3:-$SCENE_DIR/runs/golden.run.json}"

RENODE_VERSION="${RENODE_VERSION:-latest}"
RENODE_DIR="${RENODE_DIR:-$HOME/.cache/renode}"

if ! command -v renode >/dev/null 2>&1 && [ ! -x "$RENODE_DIR/renode" ]; then
  echo "::group::install renode ($RENODE_VERSION)"
  mkdir -p "$RENODE_DIR"
  curl -fsSL "https://builds.renode.io/renode-${RENODE_VERSION}.linux-portable-dotnet.tar.gz" | tar -xz -C "$RENODE_DIR" --strip-components=1
  echo "::endgroup::"
fi
export RENODE_DIR

for f in dingopdm_v7.elf canboard_v2.elf; do
  [ -f "$FW_DIR/$f" ] || { echo "missing $FW_DIR/$f"; exit 2; }
done
[ -f "$GOLDEN" ] || { echo "no golden run at $GOLDEN — record one locally first (RunsPanel → mark golden)"; exit 2; }

npm ci --omit=dev --ignore-scripts >/dev/null
node server/ci.js --scene "$SCENE_DIR" --firmware "$FW_DIR" --golden "$GOLDEN" --timeout "${CI_TIMEOUT_S:-600}"
