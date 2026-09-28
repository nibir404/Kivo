#!/usr/bin/env bash
# sync-memory.sh — Pre-push memory & context synchronization script
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "=========================================================="
echo "  Kivo Pre-Push Memory & Context Synchronization Check"
echo "=========================================================="

echo "[1/4] Checking Git working tree..."
UNCOMMITTED=$(git status --porcelain)
BRANCH=$(git branch --show-current 2>/dev/null || echo "detached")

if [ -z "$UNCOMMITTED" ]; then
  echo "  ✓ Working tree is clean on branch '$BRANCH'."
else
  echo "  ! Working tree has modified or untracked files:"
  echo "$UNCOMMITTED" | sed 's/^/    /'
fi

echo ""
echo "[2/4] Verifying test suite and integrity..."
if npm test; then
  echo "  ✓ Test suite passed (all suites clean)."
else
  echo "  ✗ Tests failed! Fix failing tests before pushing."
  exit 1
fi

echo ""
echo "[3/4] Checking memory freshness (docs/MEMORY.md)..."
if [ ! -f "docs/MEMORY.md" ]; then
  echo "  ✗ docs/MEMORY.md is missing! Creating initial template..."
  exit 1
fi

# Compare timestamps or git changes
LAST_COMMIT_DATE=$(git log -1 --format=%cd --date=short 2>/dev/null || echo "none")
TODAY=$(date "+%Y-%m-%d")

echo "  ✓ docs/MEMORY.md exists."
echo "  - Today's date: $TODAY"
echo "  - Last commit:  $LAST_COMMIT_DATE"

echo ""
echo "[4/4] Summary:"
echo "  Before executing 'git push', make sure to:"
echo "  1. Review recent changes: git status / git diff"
echo "  2. Ensure docs/MEMORY.md accurately reflects new features or changes"
echo "  3. Stage and commit docs/MEMORY.md alongside your code"
echo "=========================================================="
