#!/usr/bin/env bash
set -euo pipefail

HOOKS_DIR="$(git rev-parse --show-toplevel)/.git/hooks"
SCRIPTS_DIR="$(git rev-parse --show-toplevel)/scripts/hooks"

echo "Setting up git hooks..."

for hook in "$SCRIPTS_DIR"/*; do
  name=$(basename "$hook")
  cp "$hook" "$HOOKS_DIR/$name"
  chmod +x "$HOOKS_DIR/$name"
  echo "  Installed: $name"
done

echo "Done. Git hooks are active."
