#!/usr/bin/env bash
#
# install.sh — enable .githooks for this clone.
#
# Run once after cloning:
#   bash .githooks/install.sh

set -e
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

git config core.hooksPath .githooks
chmod +x .githooks/pre-push

echo "✓ Git hooks installed for bscode:"
echo "    core.hooksPath = $(git config --get core.hooksPath)"
echo
echo "  Pre-push will now run:"
echo "    - npx biome check apps/"
echo "    - node scripts/check-no-control-bytes.mjs"
echo "    - node scripts/check-no-eval.mjs"
echo "    - npm run typecheck"
echo "    - npm run build"
echo "    - npm run test (--isolate)"
echo
echo "  Emergency bypass:  git push --no-verify"
