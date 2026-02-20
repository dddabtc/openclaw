#!/usr/bin/env bash
set -euo pipefail

REPO_DIR=${1:-/home/ubuntu/openclaw-src}
BRANCH=${2:-personal}

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required" >&2
  exit 1
fi

echo "[1/6] fetch branch ${BRANCH}"
git -C "$REPO_DIR" fetch origin "$BRANCH"

echo "[2/6] checkout/reset to origin/${BRANCH}"
git -C "$REPO_DIR" checkout "$BRANCH"
git -C "$REPO_DIR" reset --hard "origin/$BRANCH"

echo "[3/6] install deps"
pnpm -C "$REPO_DIR" install --frozen-lockfile

echo "[4/6] build"
pnpm -C "$REPO_DIR" -s build

echo "[5/6] restart gateway"
node "$REPO_DIR/dist/entry.js" gateway restart || true

echo "[6/6] probe"
node "$REPO_DIR/dist/entry.js" gateway probe
node "$REPO_DIR/dist/entry.js" channels status --probe || true

echo "done: ${BRANCH} installed from $REPO_DIR"
